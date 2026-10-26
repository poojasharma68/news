/**
 * Detects CAPTCHA, bot-protection and access-denied responses. A detected challenge is never
 * retried or bypassed: the article is routed to manual verification instead.
 */

/** Markers that only appear on interstitial challenge pages. */
const STRONG_MARKERS = [
  {
    re: /cf-browser-verification|cf_chl_opt|cf-challenge|__cf_chl_|challenge-platform\/h\/[bg]\/orchestrate/i,
    kind: "cloudflare",
    label: "Cloudflare browser check",
  },
  {
    re: /<title>\s*(just a moment\.{0,3}|attention required! \| cloudflare)\s*<\/title>/i,
    kind: "cloudflare",
    label: "Cloudflare challenge page",
  },
  {
    re: /px-captcha|_pxCaptcha|perimeterx/i,
    kind: "bot_protection",
    label: "PerimeterX bot protection",
  },
  {
    re: /captcha-delivery\.com|geo\.captcha-delivery|datadome/i,
    kind: "bot_protection",
    label: "DataDome bot protection",
  },
  {
    re: /<title>\s*(access denied|403 forbidden|request blocked|you have been blocked)\s*<\/title>/i,
    kind: "access_denied",
    label: "Access denied page",
  },
  {
    re: /incapsula incident id|_incapsula_resource/i,
    kind: "bot_protection",
    label: "Imperva bot protection",
  },
  {
    re: /<title>[^<]*(are you a robot|verify you are (a )?human|human verification|security check|bot verification)[^<]*<\/title>/i,
    kind: "captcha",
    label: "Human verification page",
  },
];

/** Markers that can appear on normal pages too (e.g. a comment form with reCAPTCHA). */
const WEAK_MARKERS =
  /g-recaptcha|recaptcha\/api\.js|hcaptcha\.com|h-captcha|challenges\.cloudflare\.com\/turnstile|i'?m not a robot|verify you are (a )?human|unusual traffic from your (computer|network)/i;

const ARTICLE_SIGNALS =
  /<meta[^>]+(property|name)=["'](og:title|twitter:title|article:published_time)["']|application\/ld\+json/i;

export function detectChallenge({ status, headers, html }) {
  const snippet = html.slice(0, 200_000);

  if ((headers["cf-mitigated"] ?? "").toLowerCase() === "challenge") {
    return {
      blocked: true,
      kind: "cloudflare",
      reason:
        'The publisher served a Cloudflare challenge ("verify you are human").',
    };
  }

  for (const marker of STRONG_MARKERS) {
    if (marker.re.test(snippet)) {
      return {
        blocked: true,
        kind: marker.kind,
        reason: `The publisher served a ${marker.label} instead of the article.`,
      };
    }
  }

  const hasArticleSignals = ARTICLE_SIGNALS.test(snippet);
  if (
    WEAK_MARKERS.test(snippet) &&
    (status >= 400 || (!hasArticleSignals && snippet.length < 60_000))
  ) {
    return {
      blocked: true,
      kind: "captcha",
      reason:
        "The publisher requires a CAPTCHA / human verification to view this page.",
    };
  }

  if (status === 429) {
    return {
      blocked: true,
      kind: "rate_limited",
      reason: "The publisher is rate-limiting automated requests (HTTP 429).",
    };
  }
  if (status === 401 || status === 403 || status === 451) {
    return {
      blocked: true,
      kind: "access_denied",
      reason: `The publisher denied automated access (HTTP ${status}).`,
    };
  }
  if (
    status === 503 &&
    /cloudflare|akamai|imperva|sucuri/i.test(
      `${headers.server ?? ""} ${snippet.slice(0, 5000)}`,
    )
  ) {
    return {
      blocked: true,
      kind: "bot_protection",
      reason: "The publisher’s bot protection rejected the request (HTTP 503).",
    };
  }
  return { blocked: false };
}
