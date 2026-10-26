import { describe, expect, it, vi } from "vitest";
import { ArticleExtractor } from "../server/services/articleExtractor.js";
import { parseFeed } from "../server/services/alternativeSources.js";
import { detectChallenge } from "../server/services/challengeDetector.js";
import { BlockedHostRegistry } from "../server/services/hostLimiter.js";
import { parseDate, parseMetadata } from "../server/services/metadataParser.js";
import { PipelineError } from "../server/lib/errors.js";

const ARTICLE_URL = "https://news.example.com/education/story-123";

const OG_PAGE = `<!doctype html><html><head>
<title>Fallback title | Example News</title>
<meta property="og:site_name" content="Example News">
<meta property="og:title" content="Masters&#39; Union launches &amp; expands programme | Example News">
<meta property="og:description" content="  A full   description that must never be truncated by the extractor.  ">
<meta property="og:image" content="/images/featured.jpg">
<meta property="article:published_time" content="2026-10-10T09:30:00+05:30">
<link rel="canonical" href="https://news.example.com/education/story-123?ref=home">
<link rel="alternate" type="application/rss+xml" href="/rss/education.xml">
</head><body><article><img src="/logo.png" width="600"></article></body></html>`;

function res(body, init = {}) {
  return {
    url: ARTICLE_URL,
    status: 200,
    headers: {},
    contentType: "text/html; charset=utf-8",
    body: Buffer.from(body),
    truncated: false,
    redirects: [],
    ...init,
  };
}

describe("parseMetadata", () => {
  it("prefers Open Graph, resolves relative URLs and decodes entities", () => {
    const meta = parseMetadata(OG_PAGE, ARTICLE_URL);
    expect(meta.title).toBe("Masters' Union launches & expands programme");
    expect(meta.publisher).toBe("Example News");
    expect(meta.description).toBe(
      "A full description that must never be truncated by the extractor.",
    );
    expect(meta.imageUrl).toBe("https://news.example.com/images/featured.jpg");
    expect(meta.publishedAt).toBe("2026-10-10T04:00:00.000Z");
    expect(meta.canonicalUrl).toBe(
      "https://news.example.com/education/story-123?ref=home",
    );
    expect(meta.feedUrls).toEqual([
      "https://news.example.com/rss/education.xml",
    ]);
    expect(meta.sources.title).toBe("og:title");
    expect(meta.imageCandidates).not.toContain(
      "https://news.example.com/logo.png",
    );
  });

  it("falls back to Twitter cards and JSON-LD (including @graph and malformed blocks)", () => {
    const html = `<html><head>
      <meta name="twitter:title" content="Twitter title">
      <script type="application/ld+json">{ broken json </script>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
        {"@type":"Organization","@id":"#org","name":"Graph Publisher"},
        {"@type":"NewsArticle","headline":"JSON-LD headline","description":"LD description",
         "datePublished":"2026-09-01T10:00:00Z","image":[{"url":"https://cdn.example.com/a.jpg"}],
         "publisher":{"@id":"#org"}}]}</script></head><body></body></html>`;
    const meta = parseMetadata(html, ARTICLE_URL);
    expect(meta.title).toBe("Twitter title");
    expect(meta.description).toBe("LD description");
    expect(meta.publisher).toBe("Graph Publisher");
    expect(meta.publishedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(meta.imageUrl).toBe("https://cdn.example.com/a.jpg");
  });

  it("never invents missing fields and ignores off-site or homepage canonicals", () => {
    const html = `<html><head><link rel="canonical" href="https://other-site.com/x"><meta property="og:url" content="https://news.example.com/"></head><body><p>text</p></body></html>`;
    const meta = parseMetadata(html, ARTICLE_URL);
    expect(meta).toMatchObject({
      title: null,
      description: null,
      publisher: null,
      publishedAt: null,
      imageUrl: null,
      canonicalUrl: null,
    });
  });

  it("prefers a multi-word headline over a generic <title> when no metadata is declared", () => {
    const html =
      "<html><head><title>Press Trust Of India</title></head><body><h1>Students raise Rs 100 crore for ventures</h1></body></html>";
    expect(parseMetadata(html, ARTICLE_URL)).toMatchObject({
      title: "Students raise Rs 100 crore for ventures",
    });
    const short =
      "<html><head><title>Full SEO title of the story</title></head><body><h1>Menu</h1></body></html>";
    expect(parseMetadata(short, ARTICLE_URL).title).toBe(
      "Full SEO title of the story",
    );
  });

  it("uses an article-body image only as a flagged fallback", () => {
    const html = `<html><head><meta property="og:title" content="T"></head><body><article><img src="https://img.example.com/photo-large.jpg" width="900"></article></body></html>`;
    const meta = parseMetadata(html, ARTICLE_URL);
    expect(meta.imageUrl).toBe("https://img.example.com/photo-large.jpg");
    expect(meta.imageFromHeuristic).toBe(true);
  });
});

describe("parseDate", () => {
  it("handles ISO, IST suffixes and epochs, and rejects implausible values", () => {
    expect(parseDate("Oct 10, 2026, 03:00 PM IST")).toBe(
      "2026-10-10T09:30:00.000Z",
    );
    expect(parseDate("1760000000")).toBe(
      new Date(1760000000 * 1000).toISOString(),
    );
    expect(parseDate("2099-01-01")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });
});

describe("detectChallenge", () => {
  it("detects Cloudflare, CAPTCHA and access-denied pages", () => {
    expect(
      detectChallenge({
        status: 403,
        headers: { "cf-mitigated": "challenge" },
        html: "",
      }).kind,
    ).toBe("cloudflare");
    expect(
      detectChallenge({
        status: 503,
        headers: {},
        html: "<title>Just a moment...</title>",
      }).blocked,
    ).toBe(true);
    expect(
      detectChallenge({
        status: 200,
        headers: {},
        html: '<div class="g-recaptcha"></div> I\'m not a robot',
      }).kind,
    ).toBe("captcha");
    expect(
      detectChallenge({ status: 403, headers: {}, html: "nope" }).kind,
    ).toBe("access_denied");
    expect(detectChallenge({ status: 429, headers: {}, html: "" }).kind).toBe(
      "rate_limited",
    );
  });

  it("does not flag normal articles that embed reCAPTCHA in a comment form", () => {
    const html = `${OG_PAGE}<script src="https://www.google.com/recaptcha/api.js"></script>`;
    expect(detectChallenge({ status: 200, headers: {}, html }).blocked).toBe(
      false,
    );
  });
});

describe("parseFeed", () => {
  it("parses RSS items with media thumbnails", () => {
    const xml = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
      <title>Feed title</title><link>${ARTICLE_URL}</link><description><![CDATA[<p>Feed <b>summary</b></p>]]></description>
      <pubDate>Fri, 10 Oct 2026 08:00:00 GMT</pubDate><media:content url="https://img.example.com/feed.jpg"/></item></channel></rss>`;
    expect(parseFeed(xml, "https://news.example.com/rss")).toEqual([
      {
        link: ARTICLE_URL,
        title: "Feed title",
        description: "Feed summary",
        publishedAt: "2026-10-10T08:00:00.000Z",
        imageUrl: "https://img.example.com/feed.jpg",
      },
    ]);
  });
});

describe("ArticleExtractor", () => {
  const make = (
    fetchPage,
    fetchFeed = vi.fn(async () => res("", { status: 404 })),
  ) => {
    const blockedHosts = new BlockedHostRegistry(60_000);
    const extractor = new ArticleExtractor({
      fetchPage,
      fetchFeed,
      blockedHosts,
      rssEnabled: true,
    });
    return { extractor, blockedHosts, fetchFeed };
  };

  it("extracts complete metadata without fallbacks", async () => {
    const { extractor, fetchFeed } = make(async () => res(OG_PAGE));
    const result = await extractor.extract(ARTICLE_URL);
    expect(result.blocked).toBeNull();
    expect(result.method).toBe("metadata");
    expect(result.metadata.title).toBe(
      "Masters' Union launches & expands programme",
    );
    expect(fetchFeed).not.toHaveBeenCalled();
  });

  it("marks CAPTCHA pages as blocked, uses the RSS feed and does not hit the publisher again", async () => {
    const fetchPage = vi.fn(async () =>
      res('<title>Just a moment...</title><div id="cf-challenge"></div>', {
        status: 403,
      }),
    );
    const feed = `<rss><channel><item><title>From RSS</title><link>${ARTICLE_URL}</link><pubDate>Fri, 10 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
    const fetchFeed = vi.fn(async (url) =>
      url.endsWith("/feed")
        ? res(feed, { url, contentType: "application/rss+xml" })
        : res("", { url, status: 404 }),
    );
    const { extractor } = make(fetchPage, fetchFeed);

    const first = await extractor.extract(ARTICLE_URL);
    expect(first.blocked?.kind).toBe("cloudflare");
    expect(first.metadata.title).toBe("From RSS");
    expect(first.method).toBe("rss");

    const second = await extractor.extract(
      "https://news.example.com/education/story-456",
    );
    expect(second.blocked).not.toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1); // blocked host is not retried
  });

  it("stops using feeds when the feed endpoint is also challenged", async () => {
    const challenge = res("<title>Just a moment...</title>", { status: 403 });
    const fetchFeed = vi.fn(async () => challenge);
    const { extractor } = make(async () => challenge, fetchFeed);
    const result = await extractor.extract(ARTICLE_URL);
    expect(result.blocked).not.toBeNull();
    expect(result.metadata.title).toBeNull();
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it("uses browser rendering only when the static page lacks metadata", async () => {
    const renderPage = vi.fn(async () => ({
      html: OG_PAGE,
      finalUrl: ARTICLE_URL,
      status: 200,
      headers: {},
    }));
    const extractor = new ArticleExtractor({
      fetchPage: async () =>
        res(
          '<html><head><title>Loading…</title></head><body><div id="app"></div></body></html>',
        ),
      fetchFeed: async () => res("", { status: 404 }),
      renderPage,
      blockedHosts: new BlockedHostRegistry(60_000),
      rssEnabled: false,
    });
    const result = await extractor.extract(ARTICLE_URL);
    expect(renderPage).toHaveBeenCalledOnce();
    expect(result.metadata.imageUrl).toBe(
      "https://news.example.com/images/featured.jpg",
    );
    // The static shell's generic <title> is replaced by the rendered og:title.
    expect(result.metadata.title).toBe(
      "Masters' Union launches & expands programme",
    );
    expect(result.fieldSources.title).toBe("browser:og:title");
  });

  it("handles JavaScript news sites that serve a generic shell (e.g. PTI)", async () => {
    const shell = `<html><head><title>Press Trust Of India</title><meta name="publisher" content="PTI News">
      <meta property="og:image" content="https://www.ptinews.com/assets/images/logo.jpeg"></head><body><app-root></app-root></body></html>`;
    const rendered = `<html><head><title>Press Trust Of India</title><meta name="publisher" content="PTI News">
      <meta name="description" content="NEW DELHI: (Sep 24) Student and alumni ventures raised over Rs 100 crore.">
      <meta property="og:image" content="https://www.ptinews.com/assets/images/logo.jpeg"></head>
      <body><h1>Masters' Union student ventures raise over Rs 100 crore in institutional capital</h1>
      <p>NEW DELHI: (Sep 24) Student and alumni ventures raised over Rs 100 crore.</p>
      <section class="top-photos"><img class="img-fluid" src="https://pti-xml.example.com/unrelated-gallery.jpg" width="4800"></section></body></html>`;
    const extractor = new ArticleExtractor({
      fetchPage: async () => res(shell),
      fetchFeed: async () => res("", { status: 404 }),
      renderPage: async () => ({
        html: rendered,
        finalUrl: ARTICLE_URL,
        status: 200,
        headers: {},
      }),
      blockedHosts: new BlockedHostRegistry(60_000),
      rssEnabled: false,
    });
    const result = await extractor.extract(ARTICLE_URL);
    expect(result.metadata.title).toBe(
      "Masters' Union student ventures raise over Rs 100 crore in institutional capital",
    );
    expect(result.metadata.description).toMatch(/Rs 100 crore/);
    expect(result.metadata.publisher).toBe("PTI News");
    // The site logo and the unrelated "Top photos" gallery are never used as the thumbnail.
    expect(result.metadata.imageUrl).toBeNull();
    // A date without a year is not guessed.
    expect(result.metadata.publishedAt).toBeNull();
    // Editors are told why there is no photo.
    const note = result.warnings.find((w) => w.startsWith("No article photo"));
    expect(note).toMatch(/logo\.jpeg \(og:image: looks like a logo/);
    expect(note).toMatch(/1 other image is outside the article/);
  });

  it("classifies 404s as permanent and 5xx as retryable", async () => {
    const notFound = make(async () => res("", { status: 404 })).extractor;
    await expect(notFound.extract(ARTICLE_URL)).rejects.toMatchObject({
      code: "NOT_FOUND",
      retryable: false,
    });
    const serverError = make(async () => res("", { status: 502 })).extractor;
    await expect(serverError.extract(ARTICLE_URL)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("rejects unsafe URLs before any request", async () => {
    const fetchPage = vi.fn();
    const { extractor } = make(fetchPage);
    await expect(
      extractor.extract("http://127.0.0.1/x"),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
