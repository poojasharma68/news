/**
 * URL parsing, validation and normalisation shared by the dashboard and the API.
 * The API additionally performs DNS-based SSRF checks (server/lib/ssrf.js) before any request.
 */

export const MAX_URL_LENGTH = 2048;

/** Query parameters that only carry tracking information and never identify an article. */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|yclid|ref_src|cmpid|ocid|mkt_tok|s_cid|ncid)$/i;

/** Structural validation of an article URL entered by a user. */
export function checkArticleUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "Empty value" };
  if (trimmed.length > MAX_URL_LENGTH)
    return {
      ok: false,
      reason: `URL is longer than ${MAX_URL_LENGTH} characters`,
    };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    // Accept "www.example.com/article" style values copied without a scheme.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(trimmed)) {
      try {
        url = new URL(`https://${trimmed}`);
      } catch {
        return { ok: false, reason: "Not a valid URL" };
      }
    } else {
      return { ok: false, reason: "Not a valid URL" };
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: "Only http:// and https:// links are supported",
    };
  }
  if (url.username || url.password)
    return {
      ok: false,
      reason: "Links containing credentials are not allowed",
    };
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "Only standard web ports are allowed" };
  }
  const host = url.hostname.replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[")) {
    return { ok: false, reason: "Link must point to a public website domain" };
  }
  return { ok: true, url };
}

/**
 * Builds a stable de-duplication key: scheme, "www.", fragments, tracking parameters,
 * default ports and trailing slashes are ignored; remaining query parameters are sorted.
 */
export function normalizeUrlKey(input) {
  const url = new URL(input.toString());
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  const port =
    url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";

  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/") path = "";

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a, av], [b, bv]) =>
      a === b ? av.localeCompare(bv) : a.localeCompare(b),
    );
  const query = params.length
    ? `?${new URLSearchParams(params).toString()}`
    : "";

  return `${host}${port}${path}${query}`;
}

/**
 * Splits pasted text (plain text, or cells copied from Google Sheets / Excel) into URL entries.
 * Whitespace, tabs and newlines separate entries; wrapping quotes and trailing punctuation are removed.
 */
export function parseUrlList(text) {
  const tokens = text
    .split(/[\s]+/)
    .map((token) => token.replace(/^["'<([]+/, "").replace(/["'>)\],;]+$/, ""))
    .filter(Boolean);

  const seen = new Map();
  return tokens.map((raw, i) => {
    const index = i + 1;
    const check = checkArticleUrl(raw);
    if (!check.ok)
      return {
        index,
        raw,
        url: null,
        key: null,
        error: check.reason,
        duplicateOf: null,
      };
    const key = normalizeUrlKey(check.url);
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      return {
        index,
        raw,
        url: check.url.href,
        key,
        error: null,
        duplicateOf: firstIndex,
      };
    }
    seen.set(key, index);
    return {
      index,
      raw,
      url: check.url.href,
      key,
      error: null,
      duplicateOf: null,
    };
  });
}

export function uniqueValidUrls(entries) {
  return entries
    .filter((e) => e.url && !e.error && e.duplicateOf === null)
    .map((e) => e.url);
}
