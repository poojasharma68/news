/**
 * Request validation. Schemas validate request shape; per-URL safety checks (scheme, host,
 * private networks) run in NewsService/ssrf so invalid links are reported individually
 * instead of rejecting the whole batch.
 */
import { z } from "zod";
import {
  CARD_STATUSES,
  CARD_VARIANT_KEYS,
  HEX_COLOUR,
  MAX_FOCUS_ZOOM,
  MIN_CROP_SIZE,
  isCropRegion,
} from "../../shared/types.js";
import { MAX_URL_LENGTH } from "../../shared/urlUtils.js";
import { HttpError } from "../lib/errors.js";

/** Hard ceiling on raw lines per request (the unique-URL batch limit is enforced in the service). */
export const MAX_RAW_URLS = 200;

export const batchSchema = z.object({
  urls: z
    .array(z.string().max(MAX_URL_LENGTH + 100))
    .min(1, "Provide at least one URL.")
    .max(MAX_RAW_URLS),
});

export const idParamSchema = z.object({ id: z.string().uuid("Invalid id.") });

export const idListSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, "Select at least one card.").max(500),
});

export const exportSchema = idListSchema.extend({
  include_styles: z.boolean().default(false),
  format: z.enum(["snippet", "document"]).default("document"),
  variant: z.enum(CARD_VARIANT_KEYS).default("large"),
});

const nullableText = (max) => z.string().max(max).nullable().optional();

const focusPoint = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    zoom: z.number().min(1).max(MAX_FOCUS_ZOOM).optional(),
    // "contain" shows the whole image in the card, filling the leftover space; "crop" stretches
    // the free rectangle x, y, w × h (fractions of the photo) over the whole card.
    fit: z.enum(["contain", "crop"]).optional(),
    w: z.number().min(MIN_CROP_SIZE).max(1).optional(),
    h: z.number().min(MIN_CROP_SIZE).max(1).optional(),
    // Colour around the whole image (#rrggbb); without one, the image's edge colour is used.
    fill: z.string().regex(HEX_COLOUR, "Use a colour like #000000.").optional(),
  })
  .strict()
  .refine((p) => (p.fit === "crop" ? isCropRegion(p) : p.w === undefined && p.h === undefined), {
    message: "A free crop needs x, y, w and h inside the image.",
  })
  .nullable()
  .optional();

const imageFocus = z
  .object({ large: focusPoint, medium: focusPoint, small: focusPoint })
  .strict()
  .nullable();

export const cardUpdateSchema = z
  .object({
    title: nullableText(1000),
    description: nullableText(10_000),
    publisher: nullableText(300),
    published_at: z.string().max(40).nullable().optional(),
    article_url: z.string().max(MAX_URL_LENGTH).nullable().optional(),
    original_image_url: z.string().max(MAX_URL_LENGTH).nullable().optional(),
    publisher_logo_url: z.string().max(MAX_URL_LENGTH).nullable().optional(),
    // Crop per card variant (x/y 0–1, as CSS object-position; zoom ≥ 1). Only the variants sent are
    // changed; a variant set to null goes back to the automatic crop; null resets all of them.
    image_focus: imageFocus.optional(),
  })
  .strict();

/** Crops to preview (same shape as image_focus in a card update); nothing is uploaded. */
export const cropPreviewSchema = z.object({ image_focus: imageFocus }).strict();

/** Convert to CDN: optional crops to save first (same shape as image_focus in a card update). */
export const convertToCdnSchema = z.object({ image_focus: imageFocus.optional() }).strict();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.enum(CARD_STATUSES)).optional()),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  batch_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  sort: z
    .enum(["created_at", "published_at", "updated_at"])
    .default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

function validate(source, schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return next(
        new HttpError(400, details[0]?.message ?? "Invalid request.", details),
      );
    }
    res.locals[source] = result.data;
    next();
  };
}

export const validateBody = (schema) => validate("body", schema);
export const validateQuery = (schema) => validate("query", schema);
export const validateParams = (schema) => validate("params", schema);
