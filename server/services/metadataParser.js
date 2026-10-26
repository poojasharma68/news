/**
 * Pure HTML metadata extraction. Field priority: Open Graph → Twitter Card → JSON-LD → standard
 * HTML metadata/markup. Values are normalised (whitespace, entities) but never truncated or invented.
 */
import * as cheerio from "cheerio";

export const METADATA_FIELDS = [
  "title",
  "description",
  "publisher",
  "publishedAt",
  "imageUrl",
  "canonicalUrl",
  "publisherLogoUrl",
];

export function emptyMetadata() {
  return {
    title: null,
    description: null,
    publisher: null,
    publishedAt: null,
    imageUrl: null,
    canonicalUrl: null,
    publisherLogoUrl: null,
  };
}

const ARTICLE_TYPES = new Set([
  "newsarticle",
  "article",
  "reportagenewsarticle",
  "analysisnewsarticle",
  "opinionnewsarticle",
  "backgroundnewsarticle",
  "reviewnewsarticle",
  "blogposting",
  "liveblogposting",
  "techarticle",
  "report",
]);

const UNWANTED_IMAGE =
  /(^|[\/_.-])(logo|logos|favicon|avatar|avatars|sprite|placeholder|spacer|blank|pixel|1x1|transparent|icon|icons|badge|default[-_]?(og|share|image|thumb|img)|ads?|advert|banner[-_]?ad)([\/_.-]|$)/i;

/** Collapses whitespace and decodes stray HTML/entities in a metadata value. */
export function cleanText(value) {
  if (typeof value !== "string") return null;
  let text = value;
  if (/[<&]/.test(text)) {
    text = cheerio.load(`<div id="x">${text}</div>`, null, false)("#x").text();
  }
  text = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

const TZ_ABBREVIATIONS = {
  IST: "+05:30",
  GMT: "+00:00",
  UTC: "+00:00",
  BST: "+01:00",
  EST: "-05:00",
  EDT: "-04:00",
  CST: "-06:00",
  CDT: "-05:00",
  PST: "-08:00",
  PDT: "-07:00",
  SGT: "+08:00",
};

/** Parses common publication-date formats into ISO-8601. Returns null for implausible values. */
export function parseDate(value, now = new Date()) {
  if (value == null) return null;
  let raw = String(value).trim();
  if (!raw) return null;

  let date;
  if (/^\d{10}$/.test(raw)) date = new Date(Number(raw) * 1000);
  else if (/^\d{13}$/.test(raw)) date = new Date(Number(raw));
  else {
    // "2026-10-12 10:30:00" → ISO; "Oct 12, 2026, 10:30 AM IST" → "Oct 12 2026 10:30 AM +05:30"
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) raw = raw.replace(" ", "T");
    raw = raw.replace(
      /\b(IST|GMT|UTC|BST|EST|EDT|CST|CDT|PST|PDT|SGT)\b/,
      (m) => TZ_ABBREVIATIONS[m] ?? m,
    );
    raw = raw.replace(/^(?:updated|published|posted)\s*(?:on|:)?\s*/i, "");
    date = new Date(raw);
    if (Number.isNaN(date.getTime())) date = new Date(raw.replace(/,/g, ""));
    if (Number.isNaN(date.getTime())) {
      // "12 Oct 2026" / "12-10-2026" style
      const dmy = /^(\d{1,2})[\s/-]([A-Za-z]{3,9}|\d{1,2})[\s/-](\d{4})/.exec(
        raw,
      );
      if (dmy) date = new Date(`${dmy[2]} ${dmy[1]} ${dmy[3]}`);
    }
  }
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 1995 || date.getTime() > now.getTime() + 2 * 24 * 60 * 60 * 1000)
    return null;
  return date.toISOString();
}

function resolveUrl(raw, base) {
  if (!raw) return null;
  const value = raw.trim().split(/\s+/)[0];
  if (!value || value.startsWith("data:") || value.startsWith("blob:"))
    return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Returns why an image cannot be a card thumbnail, or null when it is usable. */
export function imageRejectionReason(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "invalid URL";
  }
  if (/\.(svg|ico)$/i.test(pathname)) return "SVG/icon file";
  const match = UNWANTED_IMAGE.exec(pathname);
  return match
    ? `looks like a ${match[2].toLowerCase().replace(/s$/, "")}, not an article photo`
    : null;
}

function isUsableImage(url) {
  return imageRejectionReason(url) === null;
}

function registrableDomain(hostname) {
  const labels = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (
    labels.length >= 3 &&
    tld.length === 2 &&
    ["co", "com", "org", "net", "gov", "ac", "edu", "nic", "res"].includes(
      second,
    )
  ) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

export function isSameSite(a, b) {
  try {
    return (
      registrableDomain(new URL(a).hostname) ===
      registrableDomain(new URL(b).hostname)
    );
  } catch {
    return false;
  }
}

function collectMeta($) {
  const map = new Map();
  $("meta").each((_, el) => {
    const $el = $(el);
    const content = $el.attr("content");
    if (content == null || content.trim() === "") return;
    for (const attr of ["property", "name", "itemprop"]) {
      const key = $el.attr(attr)?.trim().toLowerCase();
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(content.trim());
      map.set(key, list);
    }
  });
  return map;
}

function collectJsonLd($) {
  const nodes = [];
  const visit = (value, depth) => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (typeof value === "object") {
      const obj = value;
      nodes.push(obj);
      if (obj["@graph"]) visit(obj["@graph"], depth + 1);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = ($(el).html() ?? "")
      .trim()
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "");
    if (!raw) return;
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      try {
        visit(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " ")), 0);
      } catch {
        /* malformed JSON-LD is ignored */
      }
    }
  });
  return nodes;
}

function typesOf(node) {
  const type = node["@type"];
  const list = Array.isArray(type) ? type : [type];
  return list.filter((t) => typeof t === "string").map((t) => t.toLowerCase());
}

function firstString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  return null;
}

function jsonLdImages(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonLdImages);
  if (typeof value === "object") {
    const obj = value;
    const url =
      firstString(obj.url) ??
      firstString(obj.contentUrl) ??
      firstString(obj["@id"]);
    return url ? [url] : [];
  }
  return [];
}

function jsonLdName(value, nodes) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return jsonLdName(value[0], nodes);
  if (typeof value === "object") {
    const obj = value;
    if (typeof obj.name === "string") return obj.name;
    const ref = obj["@id"];
    if (typeof ref === "string") {
      const target = nodes.find(
        (n) => n["@id"] === ref && typeof n.name === "string",
      );
      if (target) return target.name;
    }
  }
  return null;
}

function stripPublisherSuffix(title, publisher) {
  if (!publisher) return title;
  const escaped = publisher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = title
    .replace(new RegExp(`\\s*[|\\-–—:·]\\s*${escaped}\\s*$`, "i"), "")
    .trim();
  return stripped || title;
}

export function parseMetadata(html, pageUrl) {
  const $ = cheerio.load(html);
  const meta = collectMeta($);
  const nodes = collectJsonLd($);
  const article =
    nodes.find((n) => typesOf(n).some((t) => ARTICLE_TYPES.has(t))) ??
    nodes.find((n) => typeof n.headline === "string");
  const sources = {};

  const baseHref = $("base[href]").attr("href");
  const base = resolveUrl(baseHref, pageUrl) ?? pageUrl;

  const pick = (field, candidates, transform) => {
    for (const [label, value] of candidates) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        const result = transform(v);
        if (result) {
          sources[field] = label;
          return result;
        }
      }
    }
    return null;
  };
  const m = (key) => meta.get(key) ?? [];

  // Publisher
  const publisher = pick(
    "publisher",
    [
      ["og:site_name", m("og:site_name")],
      [
        "json-ld:publisher",
        article ? jsonLdName(article.publisher, nodes) : null,
      ],
      [
        "json-ld:organization",
        nodes.find((n) =>
          typesOf(n).some(
            (t) => t === "newsmediaorganization" || t === "organization",
          ),
        )?.name,
      ],
      ["meta:application-name", m("application-name")],
      ["meta:publisher", m("publisher")],
    ],
    cleanText,
  );

  // Publisher logo: declared JSON-LD logo (the masthead) → touch icon → largest favicon.
  // ICO files are skipped because they cannot be decoded for processing.
  const orgById = (ref) => {
    const obj = Array.isArray(ref) ? ref[0] : ref;
    if (!obj || typeof obj !== "object" || obj.logo) return obj;
    return (obj["@id"] && nodes.find((n) => n["@id"] === obj["@id"])) || obj;
  };
  const organisation = nodes.find(
    (n) =>
      n.logo &&
      typesOf(n).some(
        (t) => t === "newsmediaorganization" || t === "organization",
      ),
  );
  const iconSize = (el) =>
    Math.max(
      0,
      ...String($(el).attr("sizes") ?? "")
        .split(/\s+/)
        .map((s) => parseInt(s, 10) || 0),
    );
  const icons = $('link[rel~="icon"]')
    .toArray()
    .sort((a, b) => iconSize(b) - iconSize(a))
    .map((el) => $(el).attr("href"));
  const publisherLogoUrl = pick(
    "publisherLogoUrl",
    [
      [
        "json-ld:publisher.logo",
        article ? jsonLdImages(orgById(article.publisher)?.logo) : [],
      ],
      ["json-ld:organization.logo", jsonLdImages(organisation?.logo)],
      [
        "link:apple-touch-icon",
        $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')
          .toArray()
          .sort((a, b) => iconSize(b) - iconSize(a))
          .map((el) => $(el).attr("href")),
      ],
      ["link:icon", icons],
    ],
    (v) => {
      const url = typeof v === "string" ? resolveUrl(v, base) : null;
      return url && !/\.ico$/i.test(new URL(url).pathname) ? url : null;
    },
  );

  // Title
  const headline = cleanText($("article h1, main h1, h1").first().text());
  const title = pick(
    "title",
    [
      ["og:title", m("og:title")],
      ["twitter:title", m("twitter:title")],
      ["json-ld:headline", article ? (article.headline ?? article.name) : null],
      ["meta:title", m("title")],
      // Without declared metadata, a multi-word article headline is more reliable than <title>,
      // which JavaScript-rendered sites often leave as a generic site name.
      [
        "html:h1",
        headline && headline.split(/\s+/).length >= 4 ? headline : null,
      ],
      [
        "html:title",
        $("head > title").first().text() || $("title").first().text(),
      ],
      ["html:h1", headline],
    ],
    (v) => {
      const text = cleanText(v);
      return text ? stripPublisherSuffix(text, publisher) : null;
    },
  );

  // Description
  const description = pick(
    "description",
    [
      ["og:description", m("og:description")],
      ["twitter:description", m("twitter:description")],
      ["json-ld:description", article?.description],
      ["meta:description", m("description")],
    ],
    cleanText,
  );

  // Publication date
  const timeInArticle =
    $("article time[datetime], main time[datetime]").first().attr("datetime") ??
    $('time[itemprop="datePublished"]').attr("datetime");
  const publishedAt = pick(
    "publishedAt",
    [
      ["article:published_time", m("article:published_time")],
      [
        "og:published_time",
        [...m("og:article:published_time"), ...m("og:published_time")],
      ],
      ["json-ld:datePublished", article?.datePublished],
      ["meta:datePublished", m("datepublished")],
      [
        "meta:pubdate",
        [
          ...m("pubdate"),
          ...m("publishdate"),
          ...m("publish-date"),
          ...m("parsely-pub-date"),
          ...m("sailthru.date"),
          ...m("dc.date.issued"),
          ...m("dc.date"),
          ...m("date"),
        ],
      ],
      ["html:time", timeInArticle],
      ["json-ld:dateCreated", article?.dateCreated],
    ],
    (v) => parseDate(v),
  );

  // Images (featured first). Declared metadata images are trusted over body images.
  const declared = [
    [
      "og:image",
      [...m("og:image:secure_url"), ...m("og:image"), ...m("og:image:url")],
    ],
    ["twitter:image", [...m("twitter:image"), ...m("twitter:image:src")]],
    [
      "json-ld:image",
      article
        ? [
            ...jsonLdImages(article.image),
            ...jsonLdImages(article.thumbnailUrl),
          ]
        : [],
    ],
    ["link:image_src", $('link[rel="image_src"]').attr("href")],
    ["meta:thumbnail", m("thumbnail")],
  ];
  const imageCandidates = [];
  const rejectedImages = [];
  const reject = (url, reason) => {
    if (!rejectedImages.some((r) => r.url === url))
      rejectedImages.push({ url, reason: `${reason}` });
  };
  let imageUrl = null;
  for (const [label, value] of declared) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const url = typeof v === "string" ? resolveUrl(v, base) : null;
      if (!url || imageCandidates.includes(url)) continue;
      const reason = imageRejectionReason(url);
      if (reason) {
        reject(url, `${label}: ${reason}`);
        continue;
      }
      imageCandidates.push(url);
      if (!imageUrl) {
        imageUrl = url;
        sources.imageUrl = label;
      }
    }
  }

  let imageFromHeuristic = false;
  const ARTICLE_IMAGES =
    'article img, main img, [itemprop="articleBody"] img, .article-body img, .story img';
  const imageSrc = (el) => {
    const $img = $(el);
    return resolveUrl(
      $img.attr("src") ??
        $img.attr("data-src") ??
        $img.attr("data-original") ??
        $img.attr("data-lazy-src") ??
        $img.attr("srcset"),
      base,
    );
  };
  $(ARTICLE_IMAGES).each((_, el) => {
    if (imageCandidates.length >= 8) return false;
    const width = Number($(el).attr("width") ?? "0");
    const url = imageSrc(el);
    if (!url || imageCandidates.includes(url)) return;
    if (width && width < 300) {
      reject(url, `article image too small (${width}px wide)`);
      return;
    }
    const reason = imageRejectionReason(url);
    if (reason) {
      reject(url, `article image ${reason}`);
      return;
    }
    imageCandidates.push(url);
    if (!imageUrl) {
      imageUrl = url;
      sources.imageUrl = "html:article-img";
      imageFromHeuristic = true;
    }
    return;
  });

  // Canonical URL — only trusted when it stays on the same site and is not the homepage.
  let canonicalUrl = null;
  const canonicalCandidates = [
    ["link:canonical", $('link[rel="canonical"]').attr("href")],
    ["og:url", m("og:url")[0]],
    [
      "json-ld:url",
      article
        ? (firstString(article.url) ??
          jsonLdName(article.mainEntityOfPage, nodes) ??
          undefined)
        : undefined,
    ],
  ];
  const pagePath = (() => {
    try {
      return new URL(pageUrl).pathname;
    } catch {
      return "/";
    }
  })();
  for (const [label, value] of canonicalCandidates) {
    const url = resolveUrl(value, base);
    if (!url || !isSameSite(url, pageUrl)) continue;
    if (new URL(url).pathname === "/" && pagePath !== "/") continue;
    canonicalUrl = url;
    sources.canonicalUrl = label;
    break;
  }

  const feedUrls = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase();
    if (!type.includes("rss") && !type.includes("atom")) return;
    const url = resolveUrl($(el).attr("href"), base);
    if (url && !feedUrls.includes(url)) feedUrls.push(url);
  });

  const articleImages = new Set($(ARTICLE_IMAGES).toArray());
  const imagesOutsideArticle = $("img")
    .toArray()
    .filter((el) => !articleImages.has(el))
    .map(imageSrc)
    .filter(
      (url) => !!url && isUsableImage(url) && !imageCandidates.includes(url),
    )
    .filter((url, i, all) => all.indexOf(url) === i).length;

  return {
    title,
    description,
    publisher,
    publishedAt,
    imageUrl,
    canonicalUrl,
    publisherLogoUrl,
    imageCandidates,
    sources,
    imageFromHeuristic,
    feedUrls,
    rejectedImages,
    imagesOutsideArticle,
  };
}
