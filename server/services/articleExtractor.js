/**
 * Article extraction orchestration:
 *   direct HTML metadata → Playwright rendering (only when needed and not blocked)
 *   → permitted alternative sources (publisher APIs, RSS) → manual verification.
 * Only empty fields are filled by later steps; nothing is invented.
 */
import { PipelineError } from "../lib/errors.js";
import { decodeBody } from "../lib/safeFetch.js";
import { assertUrlAllowed } from "../lib/ssrf.js";
import { tryAlternativeSources } from "./alternativeSources.js";
import { detectChallenge } from "./challengeDetector.js";
import {
  emptyMetadata,
  METADATA_FIELDS,
  parseMetadata,
} from "./metadataParser.js";

const HTML_TYPES = /text\/html|application\/xhtml\+xml/;

/**
 * Sources that are only a best guess: the page <title> (often a generic site name on
 * JavaScript-rendered sites) and images picked from the article body. A value from a stronger
 * source found later (e.g. after browser rendering) may replace them.
 */
const WEAK_SOURCES = new Set(["html:title", "html:article-img"]);
export function isWeakSource(label) {
  return !!label && WEAK_SOURCES.has(label.replace(/^browser:/, ""));
}

const HEURISTIC_IMAGE_WARNING =
  "No featured image was declared; the thumbnail was taken from the article body. Please confirm it.";

/** Explains to editors why no article photo could be used. */
export function describeMissingImage(rejected, outsideArticle) {
  const parts = ["No article photo was found on this page."];
  if (rejected.length) {
    const list = rejected
      .slice(0, 3)
      .map(
        (r) =>
          `${r.url.split("/").pop()?.split("?")[0] || r.url} (${r.reason})`,
      )
      .join("; ");
    parts.push(
      `Ignored: ${list}${rejected.length > 3 ? ` and ${rejected.length - 3} more` : ""}.`,
    );
  }
  if (outsideArticle > 0) {
    parts.push(
      `${outsideArticle} other image${outsideArticle === 1 ? " is" : "s are"} outside the article (menus, sidebars, "top photos" of other stories) and ${outsideArticle === 1 ? "was" : "were"} not used.`,
    );
  }
  parts.push(
    "Upload an image you are authorised to use, or paste an image URL.",
  );
  return parts.join(" ");
}

export class ArticleExtractor {
  constructor(deps) {
    this.deps = deps;
  }

  async extract(sourceUrl) {
    const url = assertUrlAllowed(sourceUrl);
    const host = url.hostname;
    const metadata = emptyMetadata();
    const fieldSources = {};
    const imageCandidates = [];
    const warnings = [];
    let method = null;
    let finalUrl = url.href;
    let feedUrls = [];
    let blocked = null;
    const rejectedImages = [];
    let imagesOutsideArticle = 0;
    const noteImages = (parsed) => {
      for (const r of parsed.rejectedImages)
        if (!rejectedImages.some((x) => x.url === r.url))
          rejectedImages.push(r);
      imagesOutsideArticle = Math.max(
        imagesOutsideArticle,
        parsed.imagesOutsideArticle,
      );
    };

    const merge = (data, source, labels, images, replaceWeak = false) => {
      let contributed = false;
      for (const field of METADATA_FIELDS) {
        const value = data[field];
        const upgrade =
          replaceWeak &&
          isWeakSource(fieldSources[field]) &&
          !isWeakSource(labels[field]) &&
          value !== metadata[field];
        if (value && (!metadata[field] || upgrade)) {
          metadata[field] = value;
          fieldSources[field] = labels[field] ?? source;
          // A site-wide logo alone does not mean the article was extracted.
          if (field !== "publisherLogoUrl") contributed = true;
        }
      }
      for (const image of images)
        if (!imageCandidates.includes(image)) imageCandidates.push(image);
      if (contributed && !method) method = source;
      return contributed;
    };

    const known = this.deps.blockedHosts.get(host);
    if (known) {
      blocked = { kind: known.kind, reason: known.reason };
      warnings.push(
        `Skipped a direct request: ${host} recently blocked automated access. It was not retried.`,
      );
    } else {
      const res = await this.deps.fetchPage(url.href);
      finalUrl = res.url;
      const html = decodeBody(res.body, res.contentType);
      const challenge = detectChallenge({
        status: res.status,
        headers: res.headers,
        html,
      });

      if (challenge.blocked) {
        blocked = { kind: challenge.kind, reason: challenge.reason };
        this.deps.blockedHosts.mark(host, challenge.kind, challenge.reason);
        // Feed links advertised on the blocked page are still safe to use.
        feedUrls = parseMetadata(html, finalUrl).feedUrls;
      } else if (res.status === 404 || res.status === 410) {
        throw new PipelineError(
          "NOT_FOUND",
          `The article is unavailable (HTTP ${res.status}).`,
          { status: res.status },
        );
      } else if (res.status >= 500) {
        throw new PipelineError(
          "HTTP_ERROR",
          `The publisher returned a server error (HTTP ${res.status}).`,
          { retryable: true, status: res.status },
        );
      } else if (res.status >= 400) {
        throw new PipelineError(
          "HTTP_ERROR",
          `The publisher returned HTTP ${res.status}.`,
          { status: res.status },
        );
      } else if (res.contentType && !HTML_TYPES.test(res.contentType)) {
        throw new PipelineError(
          "NOT_HTML",
          `The link is not a web page (content type: ${res.contentType.split(";")[0]}).`,
        );
      } else {
        const parsed = parseMetadata(html, finalUrl);
        feedUrls = parsed.feedUrls;
        noteImages(parsed);
        merge(parsed, "metadata", parsed.sources, parsed.imageCandidates);
        if (parsed.imageFromHeuristic) {
          warnings.push(HEURISTIC_IMAGE_WARNING);
        }
        if (res.truncated)
          warnings.push(
            "The page was very large; only the first part was analysed.",
          );
      }
    }

    // JavaScript rendering — only for pages that loaded normally but lack core metadata.
    const needsCore = () =>
      !metadata.title || !metadata.imageUrl || !metadata.description;
    const hasWeakCore = () =>
      isWeakSource(fieldSources.title) || isWeakSource(fieldSources.imageUrl);
    if (!blocked && this.deps.renderPage && (needsCore() || hasWeakCore())) {
      try {
        const rendered = await this.deps.renderPage(finalUrl);
        const challenge = detectChallenge({
          status: rendered.status,
          headers: rendered.headers,
          html: rendered.html,
        });
        if (challenge.blocked) {
          blocked = { kind: challenge.kind, reason: challenge.reason };
          this.deps.blockedHosts.mark(host, challenge.kind, challenge.reason);
        } else {
          const parsed = parseMetadata(rendered.html, rendered.finalUrl);
          noteImages(parsed);
          const labels = Object.fromEntries(
            Object.entries(parsed.sources).map(([k, v]) => [k, `browser:${v}`]),
          );
          const hadHeuristicImage = isWeakSource(fieldSources.imageUrl);
          merge(parsed, "browser", labels, parsed.imageCandidates, true);
          if (hadHeuristicImage && !isWeakSource(fieldSources.imageUrl)) {
            warnings.splice(warnings.indexOf(HEURISTIC_IMAGE_WARNING), 1);
          } else if (
            !hadHeuristicImage &&
            fieldSources.imageUrl === "browser:html:article-img"
          ) {
            warnings.push(
              "The thumbnail was taken from the rendered article body. Please confirm it.",
            );
          }
          for (const feed of parsed.feedUrls)
            if (!feedUrls.includes(feed)) feedUrls.push(feed);
        }
      } catch (err) {
        warnings.push(
          err instanceof Error ? err.message : "Browser rendering failed.",
        );
      }
    }

    // Permitted alternative sources.
    if (blocked || needsCore() || !metadata.publishedAt) {
      const alternative = await tryAlternativeSources(url.href, feedUrls, {
        fetchFeed: this.deps.fetchFeed,
        rssEnabled: this.deps.rssEnabled,
        adapters: this.deps.publisherAdapters,
      }).catch(() => null);
      if (alternative) {
        const labels = Object.fromEntries(
          Object.keys(alternative.metadata).map((k) => [k, alternative.source]),
        );
        merge(
          alternative.metadata,
          alternative.method,
          labels,
          alternative.imageCandidates,
        );
      }
    }

    if (!metadata.imageUrl && imageCandidates.length)
      metadata.imageUrl = imageCandidates[0];
    if (!metadata.imageUrl && !blocked)
      warnings.push(describeMissingImage(rejectedImages, imagesOutsideArticle));

    return {
      metadata,
      imageCandidates,
      method,
      finalUrl,
      blocked,
      warnings,
      fieldSources,
    };
  }
}
