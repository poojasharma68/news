/**
 * Per-article pipeline:
 *   URL validation → metadata extraction → image validation → image processing
 *   → CDN upload → Supabase persistence → preview-ready card.
 *
 * Each stage is persisted on the card so progress survives refreshes and restarts. Partial
 * results are always saved. Retries never repeat work that already succeeded: fields already
 * filled are kept, and an existing CDN image (or a cached upload of identical bytes) is reused.
 */
import {
  CARD_VARIANT_KEYS,
  computeMissingFields,
  focusFor,
  hasAllImageVariants,
  PRIMARY_VARIANT,
} from "../../shared/types.js";
import { normalizeUrlKey } from "../../shared/urlUtils.js";
import { PipelineError, toPipelineError } from "../lib/errors.js";
import { assertUrlAllowed } from "../lib/ssrf.js";
import { recordEvent } from "./events.js";
import { extensionFor, sha256 } from "./imageProcessor.js";

const MAX_IMAGE_ATTEMPTS = 3;

function isBlank(value) {
  return value == null || value.trim() === "";
}

function unique(values) {
  return [...new Set(values.filter((v) => !!v))];
}

/** Final status once processing ends, based on what is known about the card. */
export function finalStatus(card, blocked) {
  const missing = computeMissingFields(card);
  if (blocked || (card.verification_reason && missing.length > 0))
    return "verification_required";
  if (missing.length > 0) return "partial_data";
  if (card.warnings.length > 0) return "needs_review";
  return "completed";
}

/** Uploads one asset unless an identical one (same cache key) is already on the CDN. */
async function uploadOnce(deps, asset) {
  const cached = await deps.repo.getProcessedImage(asset.cacheKey);
  if (cached) return cached.cdn_url;
  const uploaded = await deps.cdn.upload({
    buffer: asset.buffer,
    contentType: asset.contentType,
    filename: asset.filename,
    hash: asset.hash,
    sourceUrl: asset.sourceUrl,
  });
  await deps.repo.saveProcessedImage({
    cache_key: asset.cacheKey,
    cdn_url: uploaded.url,
    width: asset.width ?? null,
    height: asset.height ?? null,
    format: asset.format ?? null,
  });
  return uploaded.url;
}

/** Uploads a processed (Sharp) output under a content-derived, collision-resistant file name. */
function uploadProcessed(deps, processed, prefix, sourceUrl) {
  const hash = sha256(processed.cacheKey);
  return uploadOnce(deps, {
    ...processed,
    hash,
    sourceUrl,
    filename: `${prefix}-${hash.slice(0, 20)}.${extensionFor(processed.format)}`,
  });
}

/**
 * Validates an image and produces every card variant (large, medium, small), each cropped around
 * its own focus point when `focus` (the card's image_focus) has one, uploading each to
 * the CDN once. Variants already uploaded (e.g. before a partial failure) are reused from the
 * processed-image cache, so retries never create duplicate assets.
 */
export async function processAndUploadVariants(deps, buffer, sourceUrl, onStage, focus = null) {
  const sourceHash = sha256(buffer);

  if (deps.cdn.inputMode === "url") {
    // A URL-ingesting CDN fetches the original itself, so it cannot receive three resized files.
    if (!sourceUrl)
      throw new PipelineError(
        "CDN_UPLOAD_FAILED",
        "This CDN ingests images by URL; uploaded files cannot be sent to it.",
      );
    await onStage?.("uploading");
    const url = await uploadOnce(deps, {
      cacheKey: `${sourceHash}:url-ingest`,
      buffer,
      contentType: "application/octet-stream",
      filename: `${deps.cdnFilenamePrefix}-${sourceHash.slice(0, 20)}`,
      hash: sourceHash,
      sourceUrl,
    });
    const variants = Object.fromEntries(
      CARD_VARIANT_KEYS.map((key) => [key, { url, width: null, height: null }]),
    );
    return { variants, cacheKey: `${sourceHash}:url-ingest`, upscaled: false };
  }

  await onStage?.("processing_image");
  const specs = deps.images.variantSpecs();
  const processed = {};
  for (const key of CARD_VARIANT_KEYS)
    processed[key] = await deps.images.process(
      buffer,
      sourceHash,
      specs[key],
      focusFor(focus, key),
    );

  await onStage?.("uploading");
  const variants = {};
  for (const key of CARD_VARIANT_KEYS) {
    const output = processed[key];
    variants[key] = {
      url: await uploadProcessed(deps, output, deps.cdnFilenamePrefix, sourceUrl),
      width: output.width,
      height: output.height,
      // The photo inside any padding that was cut off, so the editor crops the same area.
      ...(output.content && { content: output.content }),
      // The automatic crop the server chose, so the editor shows it exactly and starts from it.
      ...(output.auto && { auto: output.auto }),
    };
  }
  const primary = processed[PRIMARY_VARIANT];
  return { variants, cacheKey: primary.cacheKey, upscaled: primary.upscaled };
}

/**
 * Stores an uploaded original on the CDN as-is, so the card can be re-cropped later
 * (e.g. after the editor moves the focal point) without asking for the file again.
 */
export async function uploadOriginal(deps, buffer, format) {
  const hash = sha256(buffer);
  return uploadOnce(deps, {
    cacheKey: `${hash}:original`,
    buffer,
    contentType: `image/${format}`,
    filename: `${deps.cdnFilenamePrefix}-original-${hash.slice(0, 20)}.${extensionFor(format)}`,
    hash,
    format,
  });
}

/** Card fields that store a processed featured image (all variants plus the primary mirror). */
export function imageFields(result, source) {
  const primary = result.variants[PRIMARY_VARIANT];
  return {
    image_variants: result.variants,
    cdn_image_url: primary.url,
    cdn_image_source: source,
    image_hash: result.cacheKey,
    image_width: primary.width,
    image_height: primary.height,
  };
}

/** Converts a publisher logo and uploads it, reusing cached uploads of identical bytes. */
export async function processAndUploadLogo(deps, buffer, sourceUrl) {
  const prefix = `${deps.cdnFilenamePrefix}-logo`;
  if (deps.cdn.inputMode === "url") {
    const cacheKey = `${sha256(buffer)}:logo:url-ingest`;
    const hash = sha256(cacheKey);
    return uploadOnce(deps, {
      cacheKey,
      buffer,
      contentType: "application/octet-stream",
      filename: `${prefix}-${hash.slice(0, 20)}`,
      hash,
      sourceUrl,
    });
  }
  const processed = await deps.images.processLogo(buffer);
  return uploadProcessed(deps, processed, prefix, sourceUrl);
}

/**
 * Images to try, best first. A legacy card that only has the large CDN image (e.g. one uploaded
 * by hand) regenerates its missing variants from that image.
 */
function imageSources(card) {
  const sources = unique([card.original_image_url, ...card.image_candidates]);
  if (!sources.length && card.cdn_image_url) sources.push(card.cdn_image_url);
  return sources.slice(0, MAX_IMAGE_ATTEMPTS);
}

export function createPipeline(deps) {
  const { repo } = deps;
  // Every article from a publisher shares its logo, so uploads are remembered per source URL.
  const logoUploads = new Map();

  async function update(id, patch) {
    const card = await repo.updateCard(id, patch);
    if (!card)
      throw new PipelineError(
        "CANCELLED",
        "The card was deleted while it was being processed.",
      );
    return card;
  }

  async function runImageStages(card, warnings, correlationId) {
    const candidates = imageSources(card);
    let lastError = null;

    for (const [index, candidate] of candidates.entries()) {
      try {
        card = await update(card.id, { processing_stage: "validating_image" });
        const downloaded = await deps.images.download(candidate);
        const result = await processAndUploadVariants(
          deps,
          downloaded.buffer,
          candidate,
          async (stage) => {
            card = await update(card.id, { processing_stage: stage });
          },
          // The editor's focus points belong to the chosen image, not to fallback candidates.
          index === 0 ? card.image_focus : null,
        );
        if (index > 0)
          warnings.push(
            "The featured image could not be used; an alternative image from the article was selected. Please confirm it.",
          );
        if (result.upscaled)
          warnings.push(
            "The source image is smaller than the card size and was upscaled; it may look soft.",
          );
        card = await update(card.id, {
          processing_stage: "saving",
          // A legacy row regenerated from its own CDN image keeps its original source.
          original_image_url:
            candidate === card.cdn_image_url ? card.original_image_url : candidate,
          ...imageFields(
            result,
            candidate === card.cdn_image_url ? card.cdn_image_source : candidate,
          ),
        });
        return { card, imageError: null };
      } catch (err) {
        const error = toPipelineError(err);
        // Transient and CDN/database failures fail the job (data is kept) so the queue can retry it.
        if (
          error.retryable ||
          error.code.startsWith("CDN_") ||
          error.code === "CANCELLED" ||
          error.code === "DB_ERROR"
        )
          throw error;
        deps.logger.info("Image candidate rejected", {
          cardId: card.id,
          jobId: correlationId,
          code: error.code,
          message: error.message,
        });
        lastError = error;
      }
    }
    return { card, imageError: lastError };
  }

  /** Best effort: a missing or broken logo never fails the card or changes its status. */
  async function runLogoStage(card) {
    const source = card.publisher_logo_url;
    try {
      let cdnUrl = logoUploads.get(source);
      if (!cdnUrl) {
        const buffer = await deps.images.downloadLogo(source);
        cdnUrl = await processAndUploadLogo(deps, buffer, source);
        logoUploads.set(source, cdnUrl);
      }
      return await update(card.id, { cdn_publisher_logo_url: cdnUrl });
    } catch (err) {
      const error = toPipelineError(err);
      if (error.code === "CANCELLED") throw error;
      deps.logger.info("Publisher logo skipped", {
        cardId: card.id,
        code: error.code,
        message: error.message,
      });
      return card;
    }
  }

  return async function runJob(task, ctx) {
    const correlationId = task.jobId ?? null;
    const event = (name, details) =>
      recordEvent(deps, task.cardId, name, { correlationId, ...details });
    const existing = await repo.getCard(task.cardId);
    if (!existing)
      throw new PipelineError("CANCELLED", "The card no longer exists.");
    await event("job_started", {
      message: `Attempt ${ctx.attempt} of ${ctx.maxAttempts} (${task.mode === "resume" ? "images only" : "full fetch"}).`,
    });
    let card = await update(task.cardId, {
      status: "processing",
      processing_stage: "validating_url",
      attempts: existing.attempts + 1,
      error_code: null,
      error_message: null,
    });
    assertUrlAllowed(card.source_url);

    let blocked = false;
    const warnings = task.mode === "resume" ? [...card.warnings] : [];
    const mode = task.mode;

    if (mode === "full") {
      card = await update(card.id, { processing_stage: "extracting" });
      const result = await deps.extractor.extract(card.source_url);
      blocked = result.blocked !== null;
      warnings.push(...result.warnings);
      await event(blocked ? "blocked" : "extracted", {
        message: blocked
          ? result.blocked.reason
          : `Metadata found via ${result.method ?? "no source"}.`,
      });
      const meta = result.metadata;

      const patch = {
        image_candidates: unique([
          ...card.image_candidates,
          ...result.imageCandidates,
        ]),
        extraction_method: card.extraction_method ?? result.method,
        verification_reason: result.blocked ? result.blocked.reason : null,
      };
      if (isBlank(card.title) && meta.title) patch.title = meta.title;
      if (isBlank(card.description) && meta.description)
        patch.description = meta.description;
      if (isBlank(card.publisher) && meta.publisher)
        patch.publisher = meta.publisher;
      if (!card.published_at && meta.publishedAt)
        patch.published_at = meta.publishedAt;
      if (!card.original_image_url && meta.imageUrl)
        patch.original_image_url = meta.imageUrl;
      if (!card.publisher_logo_url && meta.publisherLogoUrl)
        patch.publisher_logo_url = meta.publisherLogoUrl;

      if (!card.canonical_url && meta.canonicalUrl) {
        const key = normalizeUrlKey(meta.canonicalUrl);
        const duplicate = await repo.findDuplicate(key, card.id);
        if (duplicate) {
          await update(card.id, {
            ...patch,
            status: "duplicate",
            processing_stage: "done",
            duplicate_of: duplicate.id,
            error_code: "DUPLICATE",
            error_message: `This link points to an article that already has a card ("${duplicate.title ?? duplicate.source_url}").`,
          });
          await event("duplicate", { status: "duplicate" });
          return;
        }
        patch.canonical_url = meta.canonicalUrl;
        patch.canonical_url_key = key;
      }
      card = await update(card.id, {
        ...patch,
        processing_stage: "saving",
        warnings,
      });
    }

    let imageError = null;
    if (!hasAllImageVariants(card) && imageSources(card).length > 0) {
      ({ card, imageError } = await runImageStages(
        card,
        warnings,
        correlationId,
      ));
      if (!imageError)
        await event("images_uploaded", {
          message: "Large, medium and small images are on the CDN.",
        });
    }

    if (!card.cdn_publisher_logo_url && card.publisher_logo_url)
      card = await runLogoStage(card);

    card = { ...card, warnings };
    const status = finalStatus(card, blocked);
    await update(card.id, {
      status,
      processing_stage: "done",
      warnings,
      missing_fields: computeMissingFields(card),
      error_code: imageError?.code ?? null,
      error_message: imageError ? `Thumbnail: ${imageError.message}` : null,
    });
    await event("job_finished", {
      status,
      message: imageError ? `Thumbnail: ${imageError.message}` : null,
    });
    deps.logger.info("Job finished", {
      cardId: card.id,
      jobId: correlationId,
      status,
      attempt: ctx.attempt,
      mode,
    });
  };
}
