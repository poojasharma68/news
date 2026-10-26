/**
 * Types and constants shared by the dashboard (src/) and the API (server/).
 * Field names use snake_case so records map 1:1 onto the Supabase `news_cards` table.
 */

export const CARD_STATUSES = [
  "queued",
  "processing",
  "completed",
  "partial_data",
  "verification_required",
  "needs_review",
  "approved",
  "published",
  "failed",
  "cancelled",
  "duplicate",
];

export const PROCESSING_STAGES = [
  "queued",
  "validating_url",
  "extracting",
  "validating_image",
  "processing_image",
  "uploading",
  "saving",
  "done",
];

export const EXTRACTION_METHODS = [
  "metadata",
  "browser",
  "api",
  "rss",
  "manual",
];

/** Fields that must be present before a card can be approved. */
export const REQUIRED_CARD_FIELDS = [
  "title",
  "publisher",
  "published_at",
  "description",
  "image",
];

export const STATUS_LABELS = {
  queued: "Queued",
  processing: "Processing",
  completed: "Ready for review",
  partial_data: "Partial data",
  verification_required: "Verification required",
  needs_review: "Needs review",
  approved: "Approved",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
  duplicate: "Duplicate",
};

export const STAGE_LABELS = {
  queued: "Waiting in queue",
  validating_url: "Validating URL",
  extracting: "Extracting metadata",
  validating_image: "Validating image",
  processing_image: "Resizing image",
  uploading: "Uploading to CDN",
  saving: "Saving",
  done: "Done",
};

export const FIELD_LABELS = {
  title: "Title",
  publisher: "Publisher",
  published_at: "Publication date",
  description: "Description",
  image: "Thumbnail (all three sizes)",
};

/** Statuses that are still moving through the pipeline. */
export const ACTIVE_STATUSES = ["queued", "processing"];
/** Statuses that can be approved once all required fields are present. */
export const APPROVABLE_STATUSES = [
  "completed",
  "needs_review",
  "partial_data",
];
/** Statuses that may be exported to the website. */
export const EXPORTABLE_STATUSES = ["approved", "published"];
/** Statuses for which a user may trigger another processing attempt. */
export const RETRYABLE_STATUSES = [
  "failed",
  "cancelled",
  "partial_data",
  "verification_required",
];
/**
 * A publisher that keeps answering with a CAPTCHA will not stop doing so on retry. After this many
 * attempts a blocked card can only be completed manually.
 */
export const MAX_BLOCKED_ATTEMPTS = 3;

/**
 * The three card outputs produced from one article. All use the existing `.newsCard` markup and
 * the same metadata; each placement gets its own featured-image variant. `large` is the original
 * card size (CARD_IMAGE_WIDTH × CARD_IMAGE_HEIGHT) and is mirrored in `cdn_image_url`.
 * Default sizes keep the website's 16:9 image box; override them with CARD_IMAGE_<VARIANT>_*.
 */
/**
 * Each variant is one card design with its own image crop, stored at 2× the on-page image box
 * (standard 402×196, feature 379×338, list 244×170). standard = image on top (existing
 * `.newsCard` markup), feature = text over a full-bleed image, list = image left, text right.
 * Keys stay large/medium/small because stored records use them.
 */
export const CARD_VARIANTS = [
  { key: "large", design: "standard", label: "Standard card", width: 804, height: 392 },
  { key: "medium", design: "feature", label: "Feature card", width: 758, height: 676 },
  { key: "small", design: "list", label: "List card", width: 488, height: 340 },
];
export const CARD_VARIANT_KEYS = CARD_VARIANTS.map((v) => v.key);
export const PRIMARY_VARIANT = "large";

/** Largest crop zoom: the crop box can shrink to 1/MAX_FOCUS_ZOOM of the largest box that fits. */
export const MAX_FOCUS_ZOOM = 6;

function isFocusPoint(point) {
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  const zoomOk =
    point?.zoom === undefined ||
    (typeof point.zoom === "number" && point.zoom >= 1 && point.zoom <= MAX_FOCUS_ZOOM);
  return !!point && ok(point.x) && ok(point.y) && zoomOk;
}

/** A copy of a valid point; zoom is left out at 1 (the largest box), so old and new records match. */
function cleanPoint(point) {
  return point.zoom > 1 ? { x: point.x, y: point.y, zoom: point.zoom } : { x: point.x, y: point.y };
}

/**
 * The crop of one variant. `image_focus` holds one per variant
 * ({ large: { x, y, zoom? }, medium: …, small: … }); a variant without one uses the automatic crop.
 * x/y place the crop box like CSS object-position (0–1); zoom (1–MAX_FOCUS_ZOOM) shrinks the box
 * from the largest one that fits, as in Figma's crop mode. A single { x, y } (older records)
 * applies to every variant.
 */
export function focusFor(imageFocus, variant) {
  if (!imageFocus) return null;
  if (isFocusPoint(imageFocus)) return cleanPoint(imageFocus);
  const point = imageFocus[variant];
  return isFocusPoint(point) ? cleanPoint(point) : null;
}

/** Applies per-variant changes (a crop, or null to go back to automatic); null when none are left. */
export function mergeFocus(current, changes) {
  const merged = {};
  for (const key of CARD_VARIANT_KEYS) {
    const next = changes && key in changes ? changes[key] : focusFor(current, key);
    if (isFocusPoint(next)) merged[key] = cleanPoint(next);
  }
  return Object.keys(merged).length ? merged : null;
}

export function samePoint(p, q) {
  return p?.x === q?.x && p?.y === q?.y && (p?.zoom ?? 1) === (q?.zoom ?? 1);
}

export function sameFocus(a, b) {
  return CARD_VARIANT_KEYS.every((key) => samePoint(focusFor(a, key), focusFor(b, key)));
}

/** The CDN URL of one image variant, or null when it has not been generated. */
export function variantImageUrl(card, variant = PRIMARY_VARIANT) {
  const url = card.image_variants?.[variant]?.url;
  if (url) return url;
  return variant === PRIMARY_VARIANT ? (card.cdn_image_url ?? null) : null;
}

export function hasAllImageVariants(card) {
  return CARD_VARIANT_KEYS.every((key) => !!variantImageUrl(card, key));
}

function isBlank(value) {
  return value == null || value.trim() === "";
}

/** Lists required fields that are still empty. A card is complete only with all CDN image variants. */
export function computeMissingFields(card) {
  const missing = [];
  if (isBlank(card.title)) missing.push("title");
  if (isBlank(card.publisher)) missing.push("publisher");
  if (isBlank(card.published_at)) missing.push("published_at");
  if (isBlank(card.description)) missing.push("description");
  if (!hasAllImageVariants(card)) missing.push("image");
  return missing;
}

/** The URL that the card's "Read More" button points to. */
export function articleLink(card) {
  return card.canonical_url || card.source_url;
}
