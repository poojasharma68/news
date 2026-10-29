/**
 * Thumbnail validation and processing with Sharp. Source images are never modified; a new,
 * resized and optimised image is produced for the card and identified by a content hash so
 * identical images are not processed or uploaded twice.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  CARD_VARIANTS,
  HEX_COLOUR,
  MAX_FOCUS_ZOOM,
  PRIMARY_VARIANT,
  isCropRegion,
} from "../../shared/types.js";
import { PipelineError } from "../lib/errors.js";

/** Input formats accepted from publishers and uploads. SVG is deliberately excluded. */
export const SUPPORTED_INPUT_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heif",
  "tiff",
]);
const ACCEPTED_CONTENT_TYPE =
  /^image\/(jpeg|jpg|pjpeg|png|webp|gif|avif|heic|heif|tiff)$/;
const CONTENT_TYPES = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
  avif: "image/avif",
};
const MAX_INPUT_PIXELS = 60_000_000;

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function specSignature(spec) {
  return `${spec.width}x${spec.height}:${spec.fit}:${spec.position}:${spec.format}:q${spec.quality}:${spec.background}`;
}

/**
 * A valid crop ({ x, y } in 0–1, optional zoom 1–MAX_FOCUS_ZOOM), { fit: "contain" } for the
 * whole image, { fit: "crop", x, y, w, h } for a free crop stretched over the card, or null.
 */
export function normalizeFocus(focus) {
  if (!focus) return null;
  if (focus.fit === "crop")
    return isCropRegion(focus) ? { x: focus.x, y: focus.y, w: focus.w, h: focus.h, fit: "crop" } : null;
  if (focus.fit === "contain")
    return { x: 0.5, y: 0.5, fit: "contain", ...(HEX_COLOUR.test(focus.fill ?? "") && { fill: focus.fill }) };
  const { x, y, zoom = 1 } = focus;
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  const zoomOk = typeof zoom === "number" && zoom >= 1 && zoom <= MAX_FOCUS_ZOOM;
  if (!ok(x) || !ok(y) || !zoomOk) return null;
  return zoom > 1 ? { x, y, zoom } : { x, y };
}

/**
 * The crop window for a cover crop of sourceWidth × sourceHeight into width × height that
 * follows a focal point, using the same rule as CSS `object-position: x% y%` so the editor's
 * live preview matches the generated image exactly. A zoom above 1 enlarges the image first,
 * so the window covers 1/zoom of the largest window that fits.
 */
export function focusCrop(sourceWidth, sourceHeight, width, height, focus) {
  const scale =
    Math.max(width / sourceWidth, height / sourceHeight) * (focus.zoom ?? 1);
  const scaledWidth = Math.max(width, Math.round(sourceWidth * scale));
  const scaledHeight = Math.max(height, Math.round(sourceHeight * scale));
  return {
    scaledWidth,
    scaledHeight,
    left: Math.round((scaledWidth - width) * focus.x),
    top: Math.round((scaledHeight - height) * focus.y),
  };
}

/** Edge colours are measured on a small copy. */
const EDGE_ANALYSIS_SIZE = 256;

/**
 * The most common colour of the listed RGBA pixels, as #rrggbb; null when most are transparent.
 * Similar colours are grouped (16 levels per channel) and the largest group is averaged, so the
 * result is always a colour the edge really has (a median per channel can mix one that is not).
 */
function dominantColour(data, pixels) {
  const opaque = pixels.filter((i) => data[i + 3] >= 128);
  // Transparent edges (a logo without a background): the card's background colour is used.
  if (!opaque.length || opaque.length < pixels.length / 2) return null;
  const groups = new Map();
  for (const i of opaque) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const group = groups.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    group.n += 1;
    group.r += data[i];
    group.g += data[i + 1];
    group.b += data[i + 2];
    groups.set(key, group);
  }
  let top = null;
  for (const group of groups.values()) if (!top || group.n > top.n) top = group;
  const hex = [top.r, top.g, top.b]
    .map((sum) => Math.round(sum / top.n).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

/**
 * The colours of a photo's edges, as #rrggbb (null when transparent): `sides` (left and right
 * columns) fills the space beside a whole image in a wider card, `ends` (top and bottom rows)
 * the space above and below it in a taller one. A logo on black gets black, so the card looks
 * seamless.
 */
export async function edgeColours(buffer, region = null) {
  const { data, info } = await (await regionImage(buffer, region))
    .resize({ width: EDGE_ANALYSIS_SIZE, height: EDGE_ANALYSIS_SIZE, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const at = (x, y) => (y * w + x) * 4;
  const sides = [];
  const ends = [];
  for (let d = 0; d < Math.min(2, w, h); d++) {
    for (let y = 0; y < h; y++) sides.push(at(d, y), at(w - 1 - d, y));
    for (let x = 0; x < w; x++) ends.push(at(x, d), at(x, h - 1 - d));
  }
  return { sides: dominantColour(data, sides), ends: dominantColour(data, ends) };
}

/** The fill around a whole sourceWidth × sourceHeight image in a width × height card. */
export function wholeImageFill(edges, sourceWidth, sourceHeight, width, height) {
  const beside = sourceWidth / sourceHeight < width / height;
  return (beside ? edges?.sides : edges?.ends) ?? null;
}

/** Fits the whole image inside width × height on a solid `fill` colour, centred. */
async function containFrame(pipeline, width, height, fill) {
  const { data, info } = await pipeline
    .resize({ width, height, fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp({ create: { width, height, channels: 4, background: fill } }).composite([
    {
      input: data,
      raw: { width: info.width, height: info.height, channels: 4 },
      left: Math.round((width - info.width) / 2),
      top: Math.round((height - info.height) / 2),
    },
  ]);
}

/** Padding detection runs on a small greyscale copy; the ratios below do not depend on its size. */
const PADDING_ANALYSIS_SIZE = 400;
/** A band of padding must cover at least this share of the side, so thin borders are kept. */
const PADDING_MIN_BAND = 0.04;
/** Padding has at most this share of the detail of the photo's middle. */
const PADDING_MAX_DETAIL = 0.2;
/** Brightness step (over 2px) that counts as part of a straight frame edge. */
const PADDING_EDGE_STEP = 24;
/** Share of a line's pixels on that step for it to be a straight frame edge, not a subject's outline. */
const PADDING_EDGE_SHARE = 0.6;
/** Share of a line's segments that must turn detailed at once where a blurred copy meets the photo. */
const PADDING_TEXTURE_SHARE = 0.6;
const PADDING_SEGMENTS = 20;
/** Centred padding: the two bands differ in width by at most this share. */
const PADDING_SYMMETRY = 0.25;
/** Centred padding: at most this share of the photo's detail (blurred copies are very smooth). */
const PADDING_SYMMETRIC_DETAIL = 0.15;
/** Centred padding: the photo's first lines have at least this share of its typical detail. */
const PADDING_JUMP = 0.6;

/**
 * Finds the padding on both ends of one axis. `px(i, j)` is the pixel on line i (along the axis)
 * at position j (across it). Returns the [start, end) lines of the photo, or null without padding.
 */
function paddingBand(n, m, px) {
  if (n < 40 || m < 20) return null;
  // Detail of each line (blurred copies and flat bars have almost none), and the share of its
  // pixels on a strong step between the neighbouring lines (a straight frame edge).
  const detail = new Float64Array(n);
  const edge = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let steps = 0;
    for (let j = 0; j < m; j++) {
      if (j + 1 < m) sum += Math.abs(px(i, j + 1) - px(i, j));
      if (i > 0 && i + 1 < n && Math.abs(px(i + 1, j) - px(i - 1, j)) >= PADDING_EDGE_STEP) steps++;
    }
    detail[i] = sum / (m - 1);
    edge[i] = steps / m;
  }
  const middle = Array.from(detail.subarray(Math.floor(n / 4), Math.ceil((3 * n) / 4))).sort(
    (a, b) => a - b,
  );
  const reference = middle[middle.length >> 1];
  if (reference < 2) return null; // a flat image: nothing to tell apart

  const smooth = (i) =>
    (detail[Math.max(0, i - 1)] + detail[i] + detail[Math.min(n - 1, i + 1)]) / 3;
  const threshold = reference * 0.3;
  let start = 0;
  while (start < n && smooth(start) < threshold) start++;
  let end = n;
  while (end > start && smooth(end - 1) < threshold) end--;
  if (end - start < n * 0.35) return null;

  // Share of the line's segments that are detailed across lines [from, to).
  const segment = Math.ceil(m / PADDING_SEGMENTS);
  const texturedShare = (from, to) => {
    let textured = 0;
    let total = 0;
    for (let s = 0; s + 1 < m; s += segment) {
      let sum = 0;
      let count = 0;
      for (let i = Math.max(0, from); i < Math.min(n, to); i++)
        for (let j = s; j < Math.min(m - 1, s + segment); j++) {
          sum += Math.abs(px(i, j + 1) - px(i, j));
          count++;
        }
      if (!count) continue;
      total++;
      if (sum / count >= threshold) textured++;
    }
    return total ? textured / total : 0;
  };

  // A side is padding when it has little detail and ends at the straight frame of a photo: a
  // hard edge (bars, dark stripes), or detail starting along most of one line (a blurred copy
  // blending into the photo). A subject on a plain backdrop has neither, so it is left alone.
  const band = (from, to, edgeFrom, edgeTo, inside, outside) => {
    if (to - from < n * PADDING_MIN_BAND) return null;
    let sum = 0;
    for (let i = from; i < to; i++) sum += detail[i];
    const level = sum / (to - from);
    if (level > reference * PADDING_MAX_DETAIL) return null;
    // The frame edge lines, nearest the photo first.
    const edges = [];
    for (let i = Math.max(1, edgeFrom); i < Math.min(n - 1, edgeTo); i++)
      if (edge[i] >= PADDING_EDGE_SHARE) edges.push(i);
    const frame =
      edges.length > 0 ||
      (texturedShare(...inside) >= PADDING_TEXTURE_SHARE && texturedShare(...outside) < 0.2);
    // Detail of the photo lines right at the boundary: a straight photo edge is fully detailed
    // at once, a subject's outline only gradually.
    let jump = 0;
    for (let i = Math.max(0, inside[0]); i < Math.min(n, inside[1]); i++)
      jump = Math.max(jump, detail[i]);
    return { edges, frame, width: to - from, level, jump };
  };
  // Plain areas of a graphic can make the photo's detail start well inside it, so the frame edge
  // is looked for across the whole band.
  let before = band(0, start, 0, start + 3, [start, start + 4], [start - 6, start - 2]);
  let after = band(end, n, end - 3, n, [end - 4, end], [end + 2, end + 6]);
  // Fit-to-frame padding is centred: smooth bands of about the same width on both sides, each
  // ending where the photo's full detail starts in one step. This catches blurred copies whose
  // edge the checks above miss (plain areas of the photo along its edge, e.g. a wall or a bench).
  const symmetric =
    before &&
    after &&
    Math.abs(before.width - after.width) <= Math.max(before.width, after.width) * PADDING_SYMMETRY &&
    [before, after].every(
      (b) => b.level <= reference * PADDING_SYMMETRIC_DETAIL && b.jump >= reference * PADDING_JUMP,
    );
  if (!symmetric) {
    if (before && !before.frame) before = null;
    if (after && !after.frame) after = null;
  }
  const cutBefore = !!before;
  const cutAfter = !!after;
  if (!cutBefore && !cutAfter) return null;
  // Cut just inside the hard edge when there is one, else a little inside the detail threshold;
  // either way the blended pixels along the frame edge are dropped.
  const small = Math.ceil(n * 0.005);
  const large = Math.ceil(n * 0.01);
  const first = !cutBefore ? 0 : before.edges.length ? before.edges.at(-1) + 1 + small : start + large;
  const last = !cutAfter ? n : after.edges.length ? after.edges[0] - small : end - large;
  return last - first >= n * 0.35 ? [first, last] : null;
}

/**
 * Finds the photo inside padding a publisher added to fit it to a fixed frame: a blurred,
 * enlarged copy of the photo behind it, or plain bars. Padding can be nested (black bars around
 * a blurred copy), so the search runs again inside what it found. Returns the photo's box as
 * fractions of the auto-rotated image ({ left, top, width, height }), or null without padding.
 */
export async function detectContentBox(buffer) {
  let box = null;
  for (let pass = 0; pass < 2; pass++) {
    const inner = await paddingBox(buffer, box);
    if (!inner) break;
    box = box
      ? {
          left: box.left + inner.left * box.width,
          top: box.top + inner.top * box.height,
          width: inner.width * box.width,
          height: inner.height * box.height,
        }
      : inner;
  }
  if (!box) return null;
  const round = (v) => Math.round(v * 10000) / 10000;
  return {
    left: round(box.left),
    top: round(box.top),
    width: round(box.width),
    height: round(box.height),
  };
}

/** The auto-rotated image, or only `region` of it (fractions of the image), ready for analysis. */
async function regionImage(buffer, region) {
  const image = sharp(buffer, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
    animated: false,
  }).rotate();
  if (!region) return image;
  const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const [w, h] = (meta.orientation ?? 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  const left = Math.round(region.left * w);
  const top = Math.round(region.top * h);
  return sharp(
    await image
      .extract({
        left,
        top,
        width: Math.min(w - left, Math.round(region.width * w)),
        height: Math.min(h - top, Math.round(region.height * h)),
      })
      .toBuffer(),
  );
}

/** One padding search inside `region` (fractions of the image, or the whole image). */
async function paddingBox(buffer, region) {
  const { data, info } = await (await regionImage(buffer, region))
    .resize({
      width: PADDING_ANALYSIS_SIZE,
      height: PADDING_ANALYSIS_SIZE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const at = (x, y) => data[(y * w + x) * channels];
  const cols = paddingBand(w, h, (i, j) => at(i, j));
  const rows = paddingBand(h, w, (i, j) => at(j, i));
  if (!cols && !rows) return null;
  const [left, right] = cols ?? [0, w];
  const [top, bottom] = rows ?? [0, h];
  return {
    left: left / w,
    top: top / h,
    width: (right - left) / w,
    height: (bottom - top) / h,
  };
}

/** Saliency is measured on a small copy; its longest side in pixels. */
const SALIENCY_SIZE = 256;
/** Weights of the saliency features: skin tones (faces, people), detail, strong colour. */
const SALIENCY_SKIN = 1.8;
const SALIENCY_DETAIL = 1;
const SALIENCY_COLOUR = 0.25;
/** Score penalties for a crop edge running through something important, and for off-centre crops. */
const CROP_CUT_PENALTY = 0.06;
const CROP_CENTRE_PENALTY = 0.04;

/**
 * How important each column and row of the photo is, for the automatic crop. Every pixel scores
 * on skin tone (so people and faces stay in frame), on local detail (edges, text, objects) and on
 * strong colour, the way smart-crop tools (and Figma plugins built on them) pick a frame.
 * `region` is the photo inside any padding (fractions of the image).
 */
export async function saliencyProfile(buffer, region = null) {
  const { data, info } = await (await regionImage(buffer, region))
    .resize({ width: SALIENCY_SIZE, height: SALIENCY_SIZE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * channels;
    lum[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  }
  const cols = new Float64Array(w);
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * channels;
      const r = data[o] / 255;
      const g = data[o + 1] / 255;
      const b = data[o + 2] / 255;
      const l = lum[i];
      // Detail: Laplacian of the brightness.
      const n = (dx, dy) => lum[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
      const detail = Math.min(1, Math.abs(4 * l - n(-1, 0) - n(1, 0) - n(0, -1) - n(0, 1)) * 4);
      // Skin: the colour's direction close to a typical skin tone, at a usable brightness.
      const mag = Math.hypot(r, g, b) || 1;
      const d = Math.hypot(r / mag - 0.78, g / mag - 0.57, b / mag - 0.44);
      const skin = l > 0.15 && l < 0.95 ? Math.max(0, (1 - d - 0.8) / 0.2) : 0;
      // Colour: saturation, ignoring very dark and very light pixels.
      const max = Math.max(r, g, b);
      const sat = max > 0 ? (max - Math.min(r, g, b)) / max : 0;
      const colour = l > 0.1 && l < 0.9 ? Math.max(0, sat - 0.4) / 0.6 : 0;
      const score = SALIENCY_SKIN * skin + SALIENCY_DETAIL * detail + SALIENCY_COLOUR * colour;
      cols[x] += score;
      rows[y] += score;
    }
  }
  return { cols, rows };
}

/**
 * Best position (0–1, as object-position) of a window `size` lines long along a profile: it keeps
 * as much of the important content as possible, avoids edges that run through it (cutting a
 * person in half) and, between equal choices, prefers the middle.
 */
function bestOffset(profile, size) {
  const n = profile.length;
  if (size >= n - 1) return 0.5;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + profile[i];
  const total = prefix[n] || 1;
  const mean = total / n;
  const edgeAt = (i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n, i + 2);
    return (prefix[b] - prefix[a]) / (b - a);
  };
  let best = 0;
  let bestScore = -Infinity;
  const span = n - size;
  for (let start = 0; start <= span; start++) {
    const kept = (prefix[start + size] - prefix[start]) / total;
    // An edge at the image border cuts nothing.
    const cut =
      ((start > 0 ? edgeAt(start) : 0) + (start < span ? edgeAt(start + size - 1) : 0)) / (2 * mean);
    const offCentre = Math.abs(start / span - 0.5) * 2;
    const score = kept - CROP_CUT_PENALTY * cut - CROP_CENTRE_PENALTY * offCentre;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return Math.round((best / span) * 1000) / 1000;
}

/** The automatic crop of a sourceWidth × sourceHeight photo into width × height, as a focus point. */
export function smartFocus(profile, sourceWidth, sourceHeight, width, height) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const w = width / (sourceWidth * scale); // share of the photo the crop keeps, per axis
  const h = height / (sourceHeight * scale);
  return {
    x: w < 0.999 ? bestOffset(profile.cols, Math.round(w * profile.cols.length)) : 0.5,
    y: h < 0.999 ? bestOffset(profile.rows, Math.round(h * profile.rows.length)) : 0.5,
  };
}

export function isAcceptedImageContentType(contentType) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  return ACCEPTED_CONTENT_TYPE.test(type);
}

/** A small per-source cache: the three variants of one image share one analysis. */
async function remember(cache, key, compute) {
  if (!cache.has(key)) {
    const value = await compute();
    if (cache.size >= 50) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  }
  return cache.get(key);
}

export class ImageService {
  constructor(spec, fetcher, fetchOptions) {
    this.spec = spec;
    this.fetcher = fetcher;
    this.fetchOptions = fetchOptions;
    this.contentBoxes = new Map();
    this.profiles = new Map();
    this.edges = new Map();
  }

  /** detectContentBox, remembered per source so the three variants analyse an image once. */
  async contentBox(buffer, sourceHash) {
    return remember(this.contentBoxes, sourceHash, () =>
      detectContentBox(buffer).catch(() => null),
    );
  }

  /** saliencyProfile of the photo inside its padding, remembered per source. */
  async edgeColours(buffer, sourceHash, content) {
    return remember(this.edges, sourceHash, () => edgeColours(buffer, content).catch(() => null));
  }

  async profile(buffer, sourceHash, content) {
    return remember(this.profiles, sourceHash, () =>
      saliencyProfile(buffer, content).catch(() => null),
    );
  }

  /**
   * Output spec of each card variant: shared crop/format settings with a per-variant size.
   * Without `spec.variants`, large uses `spec.width × spec.height` and the others their defaults.
   */
  variantSpecs() {
    return Object.fromEntries(
      CARD_VARIANTS.map((variant) => {
        const size =
          this.spec.variants?.[variant.key] ??
          (variant.key === PRIMARY_VARIANT ? this.spec : variant);
        return [
          variant.key,
          { ...this.spec, width: size.width, height: size.height },
        ];
      }),
    );
  }

  /** Downloads an image through the SSRF-safe client and validates its type and size. */
  async download(url) {
    const res = await this.fetcher(url, {
      ...this.fetchOptions,
      accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
    });
    if (res.status === 404 || res.status === 410) {
      throw new PipelineError(
        "IMAGE_DOWNLOAD_FAILED",
        `The image no longer exists (HTTP ${res.status}).`,
      );
    }
    if (res.status >= 500 || res.status === 429) {
      throw new PipelineError(
        "IMAGE_DOWNLOAD_FAILED",
        `The image host returned HTTP ${res.status}.`,
        { retryable: res.status >= 500 },
      );
    }
    if (res.status !== 200) {
      throw new PipelineError(
        "IMAGE_DOWNLOAD_FAILED",
        `The image could not be downloaded (HTTP ${res.status}).`,
      );
    }
    const type = res.contentType.split(";")[0].trim();
    if (
      type &&
      type !== "application/octet-stream" &&
      !isAcceptedImageContentType(type)
    ) {
      throw new PipelineError(
        "IMAGE_UNSUPPORTED",
        `Unsupported image content type: ${type}.`,
      );
    }
    const info = await this.inspect(res.body);
    return { buffer: res.body, info, finalUrl: res.url };
  }

  downloadLogo(url) {
    return downloadLogo(this.fetcher, url, this.fetchOptions);
  }

  processLogo(buffer) {
    return processLogo(buffer);
  }

  /** Validates image bytes (magic-number based, not trusting headers or file names). */
  async inspect(buffer) {
    if (!buffer.length)
      throw new PipelineError("IMAGE_INVALID", "The image is empty.");
    let metadata;
    try {
      metadata = await sharp(buffer, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "error",
      }).metadata();
    } catch {
      throw new PipelineError(
        "IMAGE_INVALID",
        "The file is not a valid image or is corrupted.",
      );
    }
    const format = metadata.format ?? "unknown";
    if (!SUPPORTED_INPUT_FORMATS.has(format)) {
      throw new PipelineError(
        "IMAGE_UNSUPPORTED",
        `Unsupported image format: ${format}. Use JPEG, PNG, WebP, GIF or AVIF.`,
      );
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (
      width < this.spec.minSourceWidth ||
      height < this.spec.minSourceHeight
    ) {
      throw new PipelineError(
        "IMAGE_TOO_SMALL",
        `The image is too small (${width}×${height}); at least ${this.spec.minSourceWidth}×${this.spec.minSourceHeight} is required.`,
      );
    }
    return { format, width, height, sha256: sha256(buffer) };
  }

  /**
   * Produces a card image: auto-rotated, cropped to the spec's size, metadata stripped.
   * Blurred or plain padding a publisher added around the photo is cut off first (`content` in
   * the result, as fractions of the source); focal points are relative to that photo.
   * With an editor's crop (`focus`) that crop is used; otherwise spec.position decides. With
   * "smart", the automatic crop is computed here and returned as `auto`, so the editor can show
   * the exact box and start adjusting from it.
   */
  async process(buffer, sourceHash = sha256(buffer), spec = this.spec, focus = null) {
    focus = spec.fit === "cover" ? normalizeFocus(focus) : null;
    const { width, height, fit, format, quality, background } = spec;
    // "smart" falls back to Sharp's attention crop if the image cannot be analysed.
    const position =
      spec.position === "attention" || spec.position === "smart"
        ? sharp.strategy.attention
        : spec.position === "entropy"
          ? sharp.strategy.entropy
          : spec.position;

    try {
      const source = sharp(buffer, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "error",
        animated: false,
      });
      const meta = await source.metadata();
      const orientedWidth =
        (meta.orientation ?? 1) >= 5 ? (meta.height ?? 0) : (meta.width ?? 0);
      const orientedHeight =
        (meta.orientation ?? 1) >= 5 ? (meta.width ?? 0) : (meta.height ?? 0);

      const content =
        spec.fit === "cover" && orientedWidth && orientedHeight
          ? await this.contentBox(buffer, sourceHash)
          : null;
      let pipeline = source.rotate();
      let sourceWidth = orientedWidth;
      let sourceHeight = orientedHeight;
      let contentLeft = 0;
      let contentTop = 0;
      if (content) {
        contentLeft = Math.round(content.left * orientedWidth);
        contentTop = Math.round(content.top * orientedHeight);
        sourceWidth = Math.min(orientedWidth - contentLeft, Math.round(content.width * orientedWidth));
        sourceHeight = Math.min(orientedHeight - contentTop, Math.round(content.height * orientedHeight));
        // extract() before resize() runs on the auto-rotated source. A free crop extracts its own
        // rectangle of the photo instead (Sharp keeps only one extract before a resize).
        if (focus?.fit !== "crop")
          pipeline = pipeline.extract({ left: contentLeft, top: contentTop, width: sourceWidth, height: sourceHeight });
      }
      const upscaled = sourceWidth < width || sourceHeight < height;

      let auto = null;
      if (!focus && spec.fit === "cover" && spec.position === "smart" && sourceWidth && sourceHeight) {
        const profile = await this.profile(buffer, sourceHash, content);
        if (profile) auto = smartFocus(profile, sourceWidth, sourceHeight, width, height);
      }
      const crop = focus ?? auto;

      // The colour around the whole image in this card, measured even while it is cropped, so
      // the editor can preview "Fit whole image" exactly.
      const edges =
        spec.fit === "cover" && sourceWidth && sourceHeight
          ? await this.edgeColours(buffer, sourceHash, content)
          : null;
      const edgeFill = edges
        ? wholeImageFill(edges, sourceWidth, sourceHeight, width, height)
        : null;

      if (focus?.fit === "crop" && sourceWidth && sourceHeight) {
        // The chosen rectangle fills the card's full width and height (stretched if its shape
        // differs from the card's).
        const left = Math.min(sourceWidth - 1, Math.round(focus.x * sourceWidth));
        const top = Math.min(sourceHeight - 1, Math.round(focus.y * sourceHeight));
        pipeline = pipeline
          .extract({
            left: contentLeft + left,
            top: contentTop + top,
            width: Math.max(1, Math.min(sourceWidth - left, Math.round(focus.w * sourceWidth))),
            height: Math.max(1, Math.min(sourceHeight - top, Math.round(focus.h * sourceHeight))),
          })
          .resize({ width, height, fit: "fill" });
      } else if (focus?.fit === "contain" && sourceWidth && sourceHeight) {
        pipeline = await containFrame(pipeline, width, height, focus.fill ?? edgeFill ?? background);
      } else if (crop && sourceWidth && sourceHeight) {
        const area = focusCrop(sourceWidth, sourceHeight, width, height, crop);
        // extract() after resize() runs on the resized image, in a single decode/encode.
        pipeline = pipeline
          .resize({ width: area.scaledWidth, height: area.scaledHeight, fit: "fill" })
          .extract({ left: area.left, top: area.top, width, height });
      } else {
        pipeline = pipeline.resize({
          width,
          height,
          fit,
          position,
          background,
          withoutEnlargement: false,
        });
      }
      if (format === "jpeg")
        pipeline = pipeline
          .flatten({ background })
          .jpeg({ quality, mozjpeg: true, progressive: true });
      else if (format === "webp")
        pipeline = pipeline.webp({ quality, effort: 5, smartSubsample: true });
      else if (format === "avif")
        pipeline = pipeline.avif({ quality, effort: 4 });
      else pipeline = pipeline.png({ compressionLevel: 9, palette: false });

      const { data, info } = await pipeline.toBuffer({
        resolveWithObject: true,
      });
      return {
        buffer: data,
        format,
        contentType: CONTENT_TYPES[format],
        width: info.width,
        height: info.height,
        cacheKey: `${sourceHash}:${specSignature(spec)}${content ? `:content${content.left},${content.top},${content.width},${content.height}` : ""}${focus?.fit === "contain" ? `:contain${focus.fill ?? ""}` : focus?.fit === "crop" ? `:crop${[focus.x, focus.y, focus.w, focus.h].map((v) => v.toFixed(4)).join(",")}` : focus ? `:focus${focus.x.toFixed(3)},${focus.y.toFixed(3)}${focus.zoom ? `,z${focus.zoom.toFixed(3)}` : ""}` : ""}${auto ? `:auto${auto.x.toFixed(3)},${auto.y.toFixed(3)}` : ""}`,
        sourceHash,
        upscaled,
        content,
        auto,
        edgeFill,
      };
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      throw new PipelineError(
        "IMAGE_INVALID",
        `The image could not be processed: ${err.message}`,
      );
    }
  }
}

/**
 * Publisher logos keep transparency and are stored losslessly, so flat colours and letter edges
 * stay crisp. The box is ≥3× the 100px display width, so logos are sharp on high-density screens.
 * SVG is rasterised here and never served.
 */
export const LOGO_SPEC = { maxWidth: 320, maxHeight: 160, minSize: 16 };
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_INPUT_FORMATS = new Set([...SUPPORTED_INPUT_FORMATS, "svg"]);
const LOGO_CONTENT_TYPE =
  /^image\/(jpeg|jpg|pjpeg|png|webp|gif|avif|heic|heif|tiff|svg\+xml)$/;

export function isAcceptedLogoContentType(contentType) {
  return LOGO_CONTENT_TYPE.test(contentType.split(";")[0].trim().toLowerCase());
}

/** Downloads a publisher logo through the SSRF-safe client (SVG allowed, small sizes allowed). */
export async function downloadLogo(fetcher, url, fetchOptions) {
  const res = await fetcher(url, {
    ...fetchOptions,
    maxBytes: Math.min(fetchOptions.maxBytes ?? Infinity, LOGO_MAX_BYTES),
    accept: "image/svg+xml,image/png,image/webp,image/*;q=0.8",
  });
  if (res.status !== 200) {
    throw new PipelineError(
      "IMAGE_DOWNLOAD_FAILED",
      `The logo could not be downloaded (HTTP ${res.status}).`,
    );
  }
  const type = res.contentType.split(";")[0].trim().toLowerCase();
  if (type && type !== "application/octet-stream" && !isAcceptedLogoContentType(type)) {
    throw new PipelineError(
      "IMAGE_UNSUPPORTED",
      `Unsupported logo content type: ${type}.`,
    );
  }
  return res.body;
}

/** Converts a logo to a trimmed, transparent WebP that fits inside LOGO_SPEC, without enlarging it. */
export async function processLogo(buffer) {
  const sourceHash = sha256(buffer);
  try {
    // density renders SVGs sharply before downscaling; librsvg does not load external resources.
    const source = sharp(buffer, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
      animated: false,
      density: 300,
    });
    const meta = await source.metadata();
    if (!LOGO_INPUT_FORMATS.has(meta.format ?? "")) {
      throw new PipelineError(
        "IMAGE_UNSUPPORTED",
        `Unsupported logo format: ${meta.format ?? "unknown"}.`,
      );
    }
    if ((meta.width ?? 0) < LOGO_SPEC.minSize || (meta.height ?? 0) < LOGO_SPEC.minSize) {
      throw new PipelineError(
        "IMAGE_TOO_SMALL",
        `The logo is too small (${meta.width}×${meta.height}).`,
      );
    }
    // trim removes the empty margin around the mark (same colour as the corner pixel), so the
    // logo is centred and sized by the mark itself; a single-colour image is left unchanged.
    const { data, info } = await source
      .rotate()
      .trim({ threshold: 10 })
      .resize({
        width: LOGO_SPEC.maxWidth,
        height: LOGO_SPEC.maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ lossless: true, effort: 5 })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      format: "webp",
      contentType: CONTENT_TYPES.webp,
      width: info.width,
      height: info.height,
      cacheKey: `${sourceHash}:logo:${LOGO_SPEC.maxWidth}x${LOGO_SPEC.maxHeight}:trim:lossless`,
    };
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      "IMAGE_INVALID",
      `The logo could not be processed: ${err.message}`,
    );
  }
}

export function extensionFor(format) {
  return format === "jpeg" ? "jpg" : format;
}
