/**
 * Permitted alternative metadata sources, used when a page is blocked or incomplete:
 *  1. Official publisher APIs (register adapters in PUBLISHER_API_ADAPTERS when you have access).
 *  2. Public RSS / Atom feeds published by the site.
 * Feeds are fetched at most a few times per article and never through a challenge page.
 */
import * as cheerio from "cheerio";
import { decodeBody } from "../lib/safeFetch.js";
import { normalizeUrlKey } from "../../shared/urlUtils.js";
import { detectChallenge } from "./challengeDetector.js";
import { cleanText, parseDate } from "./metadataParser.js";

/**
 * No official publisher APIs are configured by default. Add adapters here once you have
 * documented, authorised API access for a publisher (keep credentials in environment variables).
 */
export const PUBLISHER_API_ADAPTERS = [];

const COMMON_FEED_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml"];
const MAX_FEED_REQUESTS = 4;

function absolute(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Parses RSS 2.0 and Atom feeds into a flat item list. */
export function parseFeed(xml, baseUrl) {
  const $ = cheerio.load(xml, { xml: true });
  const items = [];

  $("item").each((_, el) => {
    const $el = $(el);
    const link = absolute(
      $el.children("link").first().text() ||
        $el.children("guid").first().text(),
      baseUrl,
    );
    if (!link) return;
    const image =
      $el
        .find("media\\:content[url], media\\:thumbnail[url]")
        .first()
        .attr("url") ??
      $el.children('enclosure[type^="image"]').attr("url") ??
      null;
    items.push({
      link,
      title: cleanText($el.children("title").first().text()),
      description: cleanText($el.children("description").first().text()),
      publishedAt: parseDate(
        $el.children("pubDate").first().text() ||
          $el.find("dc\\:date").first().text(),
      ),
      imageUrl: absolute(image, baseUrl),
    });
  });

  $("entry").each((_, el) => {
    const $el = $(el);
    const linkEl = $el.children('link[rel="alternate"]').first().length
      ? $el.children('link[rel="alternate"]').first()
      : $el.children("link").first();
    const link = absolute(linkEl.attr("href"), baseUrl);
    if (!link) return;
    items.push({
      link,
      title: cleanText($el.children("title").first().text()),
      description: cleanText(
        $el.children("summary").first().text() ||
          $el.children("content").first().text(),
      ),
      publishedAt: parseDate(
        $el.children("published").first().text() ||
          $el.children("updated").first().text(),
      ),
      imageUrl: absolute(
        $el
          .find("media\\:thumbnail[url], media\\:content[url]")
          .first()
          .attr("url"),
        baseUrl,
      ),
    });
  });

  return items;
}

export async function tryAlternativeSources(articleUrl, advertisedFeeds, deps) {
  const url = new URL(articleUrl);

  for (const adapter of deps.adapters ?? PUBLISHER_API_ADAPTERS) {
    if (!adapter.matches(url)) continue;
    const data = await adapter.fetch(url).catch(() => null);
    if (data && Object.values(data).some(Boolean)) {
      return {
        metadata: data,
        imageCandidates: data.imageUrl ? [data.imageUrl] : [],
        method: "api",
        source: adapter.name,
      };
    }
  }

  if (!deps.rssEnabled) return null;

  const targetKey = normalizeUrlKey(url);
  const feeds = [
    ...advertisedFeeds,
    ...COMMON_FEED_PATHS.map((p) => new URL(p, url.origin).href),
  ]
    .filter((f, i, all) => all.indexOf(f) === i)
    .slice(0, MAX_FEED_REQUESTS);

  for (const feedUrl of feeds) {
    let res;
    try {
      res = await deps.fetchFeed(feedUrl);
    } catch {
      continue;
    }
    const body = decodeBody(res.body, res.contentType);
    // Stop entirely if the feed endpoint is also behind a challenge — never try to get around it.
    if (
      detectChallenge({ status: res.status, headers: res.headers, html: body })
        .blocked
    )
      return null;
    if (
      res.status !== 200 ||
      !/<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 2000))
    )
      continue;

    const match = parseFeed(body, res.url).find((item) => {
      try {
        return normalizeUrlKey(item.link) === targetKey;
      } catch {
        return false;
      }
    });
    if (match) {
      return {
        metadata: {
          title: match.title,
          description: match.description,
          publishedAt: match.publishedAt,
          imageUrl: match.imageUrl,
        },
        imageCandidates: match.imageUrl ? [match.imageUrl] : [],
        method: "rss",
        source: `rss:${feedUrl}`,
      };
    }
  }
  return null;
}
