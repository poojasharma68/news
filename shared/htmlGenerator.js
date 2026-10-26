/**
 * Generates the Masters' Union news card markup. The structure and class names below must stay
 * identical to the existing website component; only the placeholder values are dynamic.
 * Used by the dashboard live preview and by the API export so both produce the same HTML.
 */
import { CARD_CSS } from "./newsCardStyles.js";
import {
  articleLink,
  CARD_VARIANTS,
  PRIMARY_VARIANT,
  variantImageUrl,
} from "./types.js";

export const DEFAULT_DATE_FORMAT = {
  locale: "en-US",
  month: "short",
  timeZone: "Asia/Kolkata",
};

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** Escapes text for use in HTML element content and quoted attribute values. */
export function escapeHtml(value) {
  if (value == null) return "";
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

/** Returns a normalised http(s) URL, or null for anything else (javascript:, data:, malformed…). */
export function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Formats a stored timestamp, e.g. "Oct 12, 2026", in the configured display time zone. */
export function formatPublishDate(value, options = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const opts = { ...DEFAULT_DATE_FORMAT, ...options };
  try {
    return new Intl.DateTimeFormat(opts.locale, {
      day: "numeric",
      month: opts.month,
      year: "numeric",
      timeZone: opts.timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }
}

/** Returns YYYY-MM-DD for a stored timestamp in the display time zone (used by date inputs). */
export function toDateInputValue(
  value,
  timeZone = DEFAULT_DATE_FORMAT.timeZone,
) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Converts a YYYY-MM-DD date input into a timestamp. Midday UTC keeps the same calendar date in
 * every time zone between UTC-11 and UTC+11 (including Asia/Kolkata).
 */
export function dateInputToTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Day, short/long month and year of a stored timestamp in the display time zone. */
function dateParts(value, timeZone = DEFAULT_DATE_FORMAT.timeZone) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const read = (month, zone) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { day: "numeric", month, year: "numeric", timeZone: zone })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
  let short;
  let long;
  try {
    short = read("short", timeZone);
    long = read("long", timeZone);
  } catch {
    short = read("short", "UTC");
    long = read("long", "UTC");
  }
  return { day: Number(short.day), monthShort: short.month, monthLong: long.month, year: short.year };
}

function ordinal(day) {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${{ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th"}`;
}

const CALENDAR_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>`;
const ARROW_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>`;

/** The design a variant renders with ("standard" for unknown variants). */
export function variantDesign(variant = PRIMARY_VARIANT) {
  return CARD_VARIANTS.find((v) => v.key === variant)?.design ?? "standard";
}

/**
 * Renders one news card. `options.variant` picks both the image variant and the design:
 * large → standard (the existing `.newsCard` markup), medium → feature, small → list.
 * With `options.publisherLogo`, the CDN-hosted publisher logo is shown (a logo band in the
 * standard card, above the title in the feature card); the list card always shows the name.
 */
export function generateCardHtml(card, options = {}) {
  const imageUrl =
    safeHttpUrl(variantImageUrl(card, options.variant)) ??
    options.imagePlaceholder ??
    "";
  const logoUrl = options.publisherLogo
    ? safeHttpUrl(card.cdn_publisher_logo_url)
    : null;
  const parts = dateParts(card.published_at, options.date?.timeZone);
  const fields = {
    image: escapeHtml(imageUrl),
    href: escapeHtml(
      safeHttpUrl(card.canonical_url) ?? safeHttpUrl(card.source_url) ?? "#",
    ),
    title: escapeHtml(card.title),
    description: escapeHtml(card.description),
    publisher: escapeHtml(card.publisher),
    logo: logoUrl
      ? `<img class="publisherLogo" src="${escapeHtml(logoUrl)}" alt="" loading="lazy">`
      : "",
    date: escapeHtml(formatPublishDate(card.published_at, options.date)),
    dayMonthYear: parts
      ? escapeHtml(`${parts.day} ${parts.monthShort} ${parts.year}`)
      : "",
    ordinalDayMonth: parts
      ? escapeHtml(`${ordinal(parts.day)} ${parts.monthLong}`)
      : "",
  };
  const design = variantDesign(options.variant);
  if (design === "feature") return featureCardHtml(fields);
  if (design === "list") return listCardHtml(fields);
  return standardCardHtml(fields);
}

function standardCardHtml(f) {
  const logoBand = f.logo
    ? `

    <div class="publisherLogoBand">
        ${f.logo}
    </div>`
    : "";
  return `<div class="newsCard">
    <img
        src="${f.image}"
        alt="${f.title}"
    >${logoBand}

    <div class="newsCardContent">
        <div class="upperContent">
            <p class="cardHeading">
                ${f.publisher}
            </p>

            <p class="publishDate">
                ${f.date}
            </p>
        </div>

        <div class="middleBelowTxt">
            <p class="belowHeading">
                ${f.title}
            </p>

            <p class="cardSubText">
                ${f.description}
            </p>
        </div>

        <div class="redirectDivi">
            <a
                class="btnBlack outline btnSm"
                target="_blank"
                rel="noopener noreferrer"
                href="${f.href}"
            >
                Read More
            </a>
        </div>
    </div>
</div>`;
}

function featureCardHtml(f) {
  const brand = f.logo || `<p class="featurePublisher">${f.publisher}</p>`;
  const date = f.dayMonthYear
    ? `
    <span class="featureDate">${CALENDAR_ICON}${f.dayMonthYear}</span>
`
    : "";
  return `<a class="newsCardFeature" href="${f.href}" target="_blank" rel="noopener noreferrer">
    <img class="featureImage" src="${f.image}" alt="${f.title}" loading="lazy">
${date}
    <div class="featureContent">
        ${brand}
        <p class="featureTitle">${f.title}</p>
    </div>
</a>`;
}

function listCardHtml(f) {
  const date = f.ordinalDayMonth
    ? `
        <p class="listDate">${CALENDAR_ICON}${f.ordinalDayMonth}</p>`
    : "";
  return `<div class="newsCardList">
    <img class="listImage" src="${f.image}" alt="${f.title}" loading="lazy">

    <div class="listContent">
        <p class="listPublisher">${f.publisher}</p>
        <p class="listTitle">${f.title}</p>${date}
        <a class="listLink" href="${f.href}" target="_blank" rel="noopener noreferrer">View Article ${ARROW_ICON}</a>
    </div>
</div>`;
}


/** Renders several cards as one snippet, in the given order. */
export function generateCardsHtml(cards, options = {}) {
  return cards.map((card) => generateCardHtml(card, options)).join("\n\n");
}

/**
 * The three outputs of one article: the same metadata bound to each card placement, each with
 * its own image variant. Outputs are derived from the stored record, so they can never go stale.
 */
export function buildCardOutputs(card, options = {}) {
  const article = {
    id: card.id,
    title: card.title,
    description: card.description,
    publisher: card.publisher,
    published_at: card.published_at,
    publish_date_label: formatPublishDate(card.published_at, options.date),
    article_url: safeHttpUrl(articleLink(card)),
    publisher_logo_url: safeHttpUrl(card.cdn_publisher_logo_url),
  };
  const outputs = CARD_VARIANTS.map(({ key, design, label }) => {
    const variant = card.image_variants?.[key];
    const url = variantImageUrl(card, key);
    return {
      variant: key,
      design,
      label,
      image: url
        ? { url, width: variant?.width ?? null, height: variant?.height ?? null }
        : null,
      html: generateCardHtml(card, { ...options, variant: key }),
    };
  });
  return { article, outputs };
}

export function generateExportHtml(cards, options = {}) {
  const cardsHtml = generateCardsHtml(cards, options);
  const style = options.includeStyles
    ? `<style>\n${CARD_CSS.trim()}\n</style>\n\n`
    : "";
  if (options.format !== "document") return `${style}${cardsHtml}\n`;

  const indented = cardsHtml.replace(/^/gm, "    ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(options.title ?? "Masters’ Union news cards")}</title>
${options.includeStyles ? `    <style>\n${CARD_CSS.trim().replace(/^/gm, "        ")}\n    </style>\n` : ""}</head>
<body>
${indented}
</body>
</html>
`;
}
