/**
 * Application service: batch submission and de-duplication, retries, cancellation, manual edits,
 * thumbnail replacement, approval, publishing and export. Routes stay thin and call into here.
 */
import {
  buildCardOutputs,
  dateInputToTimestamp,
  generateExportHtml,
  toDateInputValue,
} from "../../shared/htmlGenerator.js";
import {
  ACTIVE_STATUSES,
  APPROVABLE_STATUSES,
  computeMissingFields,
  CARD_VARIANT_KEYS,
  EXPORTABLE_STATUSES,
  FIELD_LABELS,
  focusFor,
  MAX_BLOCKED_ATTEMPTS,
  mergeFocus,
  RETRYABLE_STATUSES,
  sameFocus,
  STATUS_LABELS,
} from "../../shared/types.js";
import { checkArticleUrl, normalizeUrlKey } from "../../shared/urlUtils.js";
import { HttpError, toPipelineError } from "../lib/errors.js";
import { assertUrlAllowed } from "../lib/ssrf.js";
import { recordEvent } from "./events.js";
import {
  convertToCdnFields,
  imageFields,
  localImageUrls,
  processVariants,
  storeLogo,
  storeOriginal,
} from "./pipeline.js";

/** Failures that will not succeed on retry, so bulk retry skips them. */
const PERMANENT_FAILURE_CODES = new Set([
  "NOT_FOUND",
  "URL_NOT_ALLOWED",
  "INVALID_URL",
  "NOT_HTML",
  "DNS_NOT_FOUND",
  "DUPLICATE",
]);
const POST_EXTRACTION_STAGES = [
  "validating_image",
  "processing_image",
  "uploading",
  "saving",
  "done",
];

/** Cleared whenever the featured image changes, so every variant is regenerated together. */
const EMPTY_IMAGE_FIELDS = {
  image_variants: {},
  cdn_image_url: null,
  cdn_image_source: null,
  image_hash: null,
  image_width: null,
  image_height: null,
};
const IMAGE_WARNING = /thumbnail|image|photo/i;

/** A live card as the public API returns it. */
function toPublicNews(row) {
  return { ...row.live_card, id: row.id, live_since: row.site_published_at };
}

/** Why a card cannot be approved yet, and what the editor should do next (null = approvable). */
function approvalBlocker(card, onlyLocal = false) {
  if (ACTIVE_STATUSES.includes(card.status))
    return {
      next_action: "wait",
      reason: "Still processing. Approve it when processing finishes.",
    };
  if (card.status === "verification_required")
    return {
      next_action: "complete_manually",
      reason:
        "The publisher blocked automated access (CAPTCHA or bot protection). Approving does not get past that: open the article, enter the details and add the image in the editor.",
    };
  if (card.status === "failed" || card.status === "cancelled")
    return {
      next_action: "retry_or_edit",
      reason: `${card.error_message ?? "Processing did not finish."} Retry it or complete it in the editor.`,
    };
  if (card.status === "duplicate")
    return {
      next_action: "resolve_duplicate",
      reason: "Duplicate of another card. Approve the original instead.",
    };
  if (!APPROVABLE_STATUSES.includes(card.status))
    return {
      next_action: "none",
      reason: `Already ${STATUS_LABELS[card.status].toLowerCase()}.`,
    };
  const missing = computeMissingFields(card);
  if (missing.length)
    return {
      next_action: "complete_fields",
      reason: `Missing: ${missing.map((f) => FIELD_LABELS[f]).join(", ")}.`,
    };
  if (onlyLocal)
    return {
      next_action: "convert_to_cdn",
      reason: "The images are only stored locally. Open the card and click Convert to CDN first.",
    };
  return null;
}

/** An HTTP error for a pipeline failure during a request (e.g. a CDN upload). */
function asHttpError(err) {
  if (err instanceof HttpError) return err;
  const error = toPipelineError(err);
  return new HttpError(error.code === "CDN_NOT_CONFIGURED" ? 400 : 502, error.message);
}

function cleanInputText(value) {
  if (value == null) return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

export class NewsService {
  constructor(deps) {
    this.deps = deps;
  }

  get repo() {
    return this.deps.repo;
  }

  event(cardId, name, details) {
    return recordEvent(this.deps, cardId, name, details);
  }

  async requireCard(id) {
    const card = await this.repo.getCard(id);
    if (!card) throw new HttpError(404, "News card not found.");
    return card;
  }

  assertNotProcessing(card) {
    if (this.deps.queue.has(card.id) || ACTIVE_STATUSES.includes(card.status)) {
      throw new HttpError(
        409,
        "This card is currently being processed. Wait for it to finish or cancel it first.",
      );
    }
  }

  /** Resume (skip extraction) only when extraction already succeeded and a later stage failed. */
  retryModeFor(card) {
    const extracted = !!card.title && !!card.extraction_method;
    return extracted &&
      card.status === "failed" &&
      POST_EXTRACTION_STAGES.includes(card.processing_stage)
      ? "resume"
      : "full";
  }

  async requeue(card, mode, patch = {}, actor = null) {
    const updated = await this.repo.updateCard(card.id, {
      ...patch,
      status: "queued",
      processing_stage: "queued",
      error_code: null,
      error_message: null,
    });
    if (!updated) throw new HttpError(404, "News card not found.");
    this.deps.queue.enqueue(card.id, mode);
    await this.event(card.id, "requeued", {
      status: "queued",
      actor,
      message: mode === "resume" ? "Images only." : "Full fetch.",
    });
    return updated;
  }

  // ── Batches ────────────────────────────────────────────────────────────────

  async submitBatch(urls, user) {
    const skipped = [];
    const accepted = [];
    const seen = new Set();

    for (const raw of urls) {
      const check = checkArticleUrl(raw);
      if (!check.ok) {
        skipped.push({ url: raw, reason: "invalid", message: check.reason });
        continue;
      }
      try {
        assertUrlAllowed(check.url);
      } catch (err) {
        skipped.push({ url: raw, reason: "invalid", message: err.message });
        continue;
      }
      const key = normalizeUrlKey(check.url);
      if (seen.has(key)) {
        skipped.push({
          url: raw,
          reason: "duplicate_in_batch",
          message: "Duplicate of another link in this batch.",
        });
        continue;
      }
      seen.add(key);
      accepted.push({ url: check.url.href, key });
    }

    if (accepted.length > this.deps.maxBatchSize) {
      throw new HttpError(
        400,
        `A batch can contain at most ${this.deps.maxBatchSize} unique URLs (received ${accepted.length}).`,
      );
    }
    if (accepted.length === 0) return { batch: null, queued: [], skipped };

    const existing = await this.repo.findCardsByUrlKeys(
      accepted.map((a) => a.key),
    );
    const existingByKey = new Map();
    for (const card of existing) {
      existingByKey.set(card.source_url_key, card);
      if (card.canonical_url_key)
        existingByKey.set(card.canonical_url_key, card);
    }

    const toInsert = [];
    const toRequeue = [];
    for (const item of accepted) {
      const match = existingByKey.get(item.key);
      if (!match) {
        toInsert.push(item);
      } else if (toRequeue.some((c) => c.id === match.id)) {
        skipped.push({
          url: item.url,
          reason: "duplicate_in_batch",
          message: "Points to the same article as another link in this batch.",
        });
      } else if (
        (match.status === "failed" || match.status === "cancelled") &&
        !this.deps.queue.has(match.id)
      ) {
        toRequeue.push(match);
      } else {
        skipped.push({
          url: item.url,
          reason: "already_exists",
          message: `Already in the library (${STATUS_LABELS[match.status]}).`,
          card_id: match.id,
          status: match.status,
        });
      }
    }

    if (toInsert.length === 0 && toRequeue.length === 0)
      return { batch: null, queued: [], skipped };

    const batch = await this.repo.createBatch({
      submitted_count: urls.length,
      skipped,
      created_by: user,
    });
    const inserted = await this.repo.insertCards(
      toInsert.map((item) => ({
        batch_id: batch.id,
        source_url: item.url,
        source_url_key: item.key,
        status: "queued",
        processing_stage: "queued",
      })),
    );

    // A concurrent submission may have created some of these rows first; never duplicate them.
    const insertedKeys = new Set(inserted.map((c) => c.source_url_key));
    for (const item of toInsert) {
      if (!insertedKeys.has(item.key)) {
        skipped.push({
          url: item.url,
          reason: "already_exists",
          message: "Already submitted in another batch.",
        });
      }
    }

    const queued = [];
    for (const card of inserted) {
      this.deps.queue.enqueue(card.id, "full");
      await this.event(card.id, "submitted", { status: "queued", actor: user });
      queued.push(card);
    }
    for (const card of toRequeue) {
      queued.push(
        await this.requeue(
          card,
          this.retryModeFor(card),
          { batch_id: batch.id },
          user,
        ),
      );
    }

    this.deps.logger.info("Batch submitted", {
      batchId: batch.id,
      queued: queued.length,
      skipped: skipped.length,
    });
    return { batch: { ...batch, skipped }, queued, skipped };
  }

  async getBatch(id) {
    const batch = await this.repo.getBatch(id);
    if (!batch) throw new HttpError(404, "Batch not found.");
    const cards = await this.repo.listCardsByBatch(id);
    const byStatus = {};
    for (const card of cards)
      byStatus[card.status] = (byStatus[card.status] ?? 0) + 1;
    const active = cards.filter((c) =>
      ACTIVE_STATUSES.includes(c.status),
    ).length;
    return {
      ...batch,
      cards,
      progress: {
        total: cards.length,
        finished: cards.length - active,
        active,
        by_status: byStatus,
      },
    };
  }

  listBatches(limit) {
    return this.repo.listBatches(limit);
  }

  async retryBatch(batchId) {
    const { cards } = await this.getBatch(batchId);
    const eligible = cards.filter(
      (c) =>
        !this.deps.queue.has(c.id) &&
        (c.status === "cancelled" ||
          (c.status === "failed" &&
            !PERMANENT_FAILURE_CODES.has(c.error_code ?? ""))),
    );
    for (const card of eligible)
      await this.requeue(card, this.retryModeFor(card));
    return {
      retried: eligible.map((c) => c.id),
      skipped: cards.length - eligible.length,
    };
  }

  async cancelBatch(batchId) {
    const { cards } = await this.getBatch(batchId);
    const cancelled = [];
    const running = [];
    for (const card of cards.filter((c) =>
      ACTIVE_STATUSES.includes(c.status),
    )) {
      const outcome = await this.cancelCard(card.id).then(
        () => "cancelled",
        () => "running",
      );
      (outcome === "cancelled" ? cancelled : running).push(card.id);
    }
    return { cancelled, running };
  }

  // ── Single-card job control ────────────────────────────────────────────────

  async retryCard(id, user = null) {
    const card = await this.requireCard(id);
    if (this.deps.queue.has(id))
      throw new HttpError(409, "This card is already queued or processing.");
    if (!RETRYABLE_STATUSES.includes(card.status)) {
      throw new HttpError(
        409,
        `Cards with status "${STATUS_LABELS[card.status]}" cannot be retried.`,
      );
    }
    if (
      card.status === "verification_required" &&
      card.attempts >= MAX_BLOCKED_ATTEMPTS
    ) {
      throw new HttpError(
        409,
        `The publisher has blocked automated access ${card.attempts} times. Complete this card manually in the editor.`,
      );
    }
    return this.requeue(card, this.retryModeFor(card), {}, user);
  }

  /** Retries each card independently and reports which were queued and which were refused. */
  async retryCards(ids, user) {
    const retried = [];
    const rejected = [];
    for (const id of ids) {
      try {
        retried.push(await this.retryCard(id, user));
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        rejected.push({ id, reason: err.message });
      }
    }
    return { retried, rejected };
  }

  async cancelCard(id) {
    const card = await this.requireCard(id);
    const outcome = this.deps.queue.cancel(id);
    if (outcome === "running")
      throw new HttpError(
        409,
        "Processing has already started for this card and cannot be cancelled.",
      );
    if (outcome === "not_found" && card.status !== "queued")
      throw new HttpError(409, "Only queued cards can be cancelled.");
    const updated = await this.repo.updateCard(id, {
      status: "cancelled",
      error_code: "CANCELLED",
      error_message: "Cancelled before processing started.",
    });
    await this.event(id, "cancelled", { status: "cancelled" });
    return updated ?? card;
  }

  /** Called by the queue between attempts of a transient failure. */
  async handleRetryScheduled(task, error, delayMs) {
    const message = `Attempt ${task.attempt} failed: ${error.message} Retrying in ${Math.ceil(delayMs / 1000)} s.`;
    await this.repo.updateCard(task.cardId, {
      error_code: error.code,
      error_message: message,
    });
    await this.event(task.cardId, "retry_scheduled", {
      message,
      correlationId: task.jobId,
    });
  }

  /** Called by the queue when a job fails permanently or exhausts its retries. */
  async handleJobFailure(task, error) {
    if (error.code === "CANCELLED") return;
    const card = await this.repo.getCard(task.cardId);
    if (!card) return;
    await this.repo.updateCard(task.cardId, {
      status: "failed",
      error_code: error.code,
      error_message: error.message,
      missing_fields: computeMissingFields(card),
    });
    await this.event(task.cardId, "job_failed", {
      status: "failed",
      message: `${error.code}: ${error.message}`,
      correlationId: task.jobId,
    });
  }

  /** Re-queues jobs that were queued or running when the server stopped. */
  async recover() {
    const cards = await this.repo.listCardsByStatus(["queued", "processing"]);
    for (const card of cards) {
      const extracted =
        !!card.title && POST_EXTRACTION_STAGES.includes(card.processing_stage);
      await this.repo.updateCard(card.id, {
        status: "queued",
        processing_stage: "queued",
      });
      this.deps.queue.enqueue(card.id, extracted ? "resume" : "full");
    }
    return cards.length;
  }

  // ── Library ────────────────────────────────────────────────────────────────

  listCards(filters) {
    return this.repo.listCards(filters);
  }

  getStats() {
    return this.repo.getStats();
  }

  getCard(id) {
    return this.requireCard(id);
  }

  async listEvents(id) {
    await this.requireCard(id);
    return this.repo.listEvents(id, 100);
  }

  /** The three card outputs (shared metadata + one image variant each) for one article. */
  async getOutputs(id) {
    const card = await this.requireCard(id);
    return {
      status: card.status,
      ready: EXPORTABLE_STATUSES.includes(card.status),
      missing_fields: computeMissingFields(card),
      ...buildCardOutputs(card, {
        date: this.deps.dateFormat,
        publisherLogo: this.deps.showPublisherLogo,
      }),
    };
  }

  async deleteCard(id) {
    this.deps.queue.cancel(id);
    const deleted = await this.repo.deleteCard(id);
    if (!deleted) throw new HttpError(404, "News card not found.");
  }

  /** Status after a manual edit or thumbnail replacement (never auto-approves). */
  statusAfterManualChange(before, after) {
    const missing = computeMissingFields(after);
    if (before.status === "approved" || before.status === "published") {
      return {
        status: "needs_review",
        approved_at: null,
        approved_by: null,
        missing_fields: missing,
      };
    }
    if (before.status === "duplicate")
      return { status: "duplicate", missing_fields: missing };
    if (missing.length === 0) {
      return {
        status: before.status === "needs_review" ? "needs_review" : "completed",
        missing_fields: missing,
      };
    }
    if (
      before.status === "verification_required" ||
      before.status === "failed" ||
      before.status === "cancelled"
    ) {
      return { status: before.status, missing_fields: missing };
    }
    return { status: "partial_data", missing_fields: missing };
  }

  async updateCard(id, input, user = null) {
    const card = await this.requireCard(id);
    this.assertNotProcessing(card);

    const patch = {};
    let contentChanged = false;

    for (const field of ["title", "description", "publisher"]) {
      if (input[field] === undefined) continue;
      const value = cleanInputText(input[field] ?? null);
      if (value !== card[field]) {
        patch[field] = value;
        contentChanged = true;
      }
    }

    if (input.published_at !== undefined) {
      let timestamp = null;
      if (input.published_at) {
        timestamp = dateInputToTimestamp(input.published_at);
        if (!timestamp) {
          const parsed = new Date(input.published_at);
          if (Number.isNaN(parsed.getTime()))
            throw new HttpError(
              400,
              "Publication date must be a valid date (YYYY-MM-DD).",
            );
          timestamp = parsed.toISOString();
        }
      }
      const tz = this.deps.dateFormat.timeZone;
      if (
        toDateInputValue(timestamp, tz) !==
        toDateInputValue(card.published_at, tz)
      ) {
        patch.published_at = timestamp;
        contentChanged = true;
      }
    }

    if (input.article_url !== undefined) {
      const value = input.article_url?.trim() || null;
      if (!value) {
        if (card.canonical_url) {
          patch.canonical_url = null;
          patch.canonical_url_key = null;
          contentChanged = true;
        }
      } else {
        const check = checkArticleUrl(value);
        if (!check.ok)
          throw new HttpError(400, `Article URL: ${check.reason}.`);
        assertUrlAllowed(check.url);
        const key = normalizeUrlKey(check.url);
        if (check.url.href !== card.canonical_url) {
          const duplicate =
            key === card.source_url_key
              ? null
              : await this.repo.findDuplicate(key, card.id);
          if (duplicate) {
            throw new HttpError(
              409,
              `Another card already uses this article URL ("${duplicate.title ?? duplicate.source_url}").`,
            );
          }
          patch.canonical_url = check.url.href;
          patch.canonical_url_key = key;
          contentChanged = true;
        }
      }
    }

    let needsImage = false;
    if (input.original_image_url !== undefined) {
      const value = input.original_image_url?.trim() || null;
      if (value !== card.original_image_url) {
        if (value) {
          const url = assertUrlAllowed(value);
          patch.original_image_url = url.href;
          patch.image_candidates = [
            url.href,
            ...card.image_candidates.filter((c) => c !== url.href),
          ];
          patch.warnings = card.warnings.filter((w) => !IMAGE_WARNING.test(w));
          needsImage = true;
        } else {
          patch.original_image_url = null;
        }
        Object.assign(patch, EMPTY_IMAGE_FIELDS);
        // A focal point belongs to one image; a new image starts with the automatic crop.
        patch.image_focus = null;
        contentChanged = true;
      }
    }

    // Each variant has its own focus point. Changing any of them re-creates the variants from the
    // original image; unchanged variants have the same cache key, so they are not uploaded again.
    if (input.image_focus !== undefined && patch.original_image_url === undefined) {
      const current = card.image_focus ?? null;
      const value = input.image_focus === null ? null : mergeFocus(current, input.image_focus);
      if (!sameFocus(value, current)) {
        if (!card.original_image_url)
          throw new HttpError(
            400,
            "This card has no original image to re-crop. Upload the image again first.",
          );
        patch.image_focus = value;
        Object.assign(patch, EMPTY_IMAGE_FIELDS);
        needsImage = true;
        contentChanged = true;
      }
    }

    // The logo is optional and does not affect the card's status; a new one is processed on save.
    let needsLogo = false;
    if (input.publisher_logo_url !== undefined) {
      const value = input.publisher_logo_url?.trim() || null;
      if (value !== card.publisher_logo_url) {
        patch.publisher_logo_url = value ? assertUrlAllowed(value).href : null;
        patch.cdn_publisher_logo_url = null;
        needsLogo = !!value;
        contentChanged = true;
      }
    }

    if (!contentChanged) return card;
    if (!card.extraction_method || card.status === "verification_required")
      patch.extraction_method = "manual";
    await this.event(id, "edited", {
      actor: user,
      message: `Changed: ${Object.keys(input)
        .filter((key) => input[key] !== undefined)
        .join(", ")}.`,
    });

    if (needsImage || needsLogo) {
      // Resume the remaining pipeline (image validation → processing → CDN) for the new image.
      const reverted =
        card.status === "approved" || card.status === "published"
          ? { approved_at: null, approved_by: null }
          : {};
      return this.requeue(card, "resume", { ...patch, ...reverted }, user);
    }

    const merged = { ...card, ...patch };
    const updated = await this.repo.updateCard(id, {
      ...patch,
      ...this.statusAfterManualChange(card, merged),
    });
    if (!updated) throw new HttpError(404, "News card not found.");
    return updated;
  }

  /**
   * Crops all three variants for `changes` (as image_focus in updateCard) without uploading them,
   * so the editor can review the result before "Convert to CDN" saves the crops and uploads.
   */
  async previewCrop(id, changes) {
    const card = await this.requireCard(id);
    this.assertNotProcessing(card);
    if (!card.original_image_url)
      throw new HttpError(
        400,
        "This card has no original image to re-crop. Upload the image again first.",
      );
    const focus = changes === null ? null : mergeFocus(card.image_focus ?? null, changes);
    // The local test CDN reads its own files from disk; real URLs are downloaded.
    const buffer =
      (await this.deps.cdn.read?.(card.original_image_url)) ??
      (await this.deps.images.download(card.original_image_url)).buffer;
    const specs = this.deps.images.variantSpecs();
    const variants = {};
    for (const key of CARD_VARIANT_KEYS) {
      const output = await this.deps.images.process(
        buffer,
        undefined,
        specs[key],
        focusFor(focus, key),
      );
      variants[key] = {
        url: `data:${output.contentType};base64,${output.buffer.toString("base64")}`,
        width: output.width,
        height: output.height,
        ...(output.content && { content: output.content }),
        ...(output.auto && { auto: output.auto }),
        ...(output.edgeFill && { edgeFill: output.edgeFill }),
      };
    }
    return { image_focus: focus, variants };
  }

  /**
   * Replaces the featured image with an uploaded file and regenerates all three variants; they
   * are stored locally until Convert to CDN.
   */
  async uploadThumbnail(id, buffer, user = null) {
    const card = await this.requireCard(id);
    this.assertNotProcessing(card);
    const info = await this.deps.images.inspect(buffer);
    const result = await processVariants(this.deps, buffer, undefined);
    const patch = {
      ...imageFields(result, `upload:${info.sha256}`),
      // Kept so the focal point can be changed later without a new upload.
      original_image_url: await storeOriginal(this.deps, buffer, info.format),
      image_focus: null,
      error_code: null,
      error_message: null,
      warnings: card.warnings.filter((w) => !IMAGE_WARNING.test(w)),
    };
    if (!card.extraction_method || card.status === "verification_required")
      patch.extraction_method = "manual";
    const merged = { ...card, ...patch };
    const updated = await this.repo.updateCard(id, {
      ...patch,
      ...this.statusAfterManualChange(card, merged),
    });
    if (!updated) throw new HttpError(404, "News card not found.");
    await this.event(id, "thumbnail_uploaded", {
      status: updated.status,
      actor: user,
    });
    return updated;
  }

  /** Stores an uploaded publisher logo (locally until Convert to CDN), apart from the featured image. */
  async uploadLogo(id, buffer, user = null) {
    const card = await this.requireCard(id);
    this.assertNotProcessing(card);
    const cdnUrl = await storeLogo(this.deps, buffer, undefined);
    // An uploaded logo has no source URL; the CDN copy is the logo.
    const updated = await this.repo.updateCard(id, {
      publisher_logo_url: null,
      cdn_publisher_logo_url: cdnUrl,
    });
    if (!updated) throw new HttpError(404, "News card not found.");
    await this.event(id, "logo_uploaded", { actor: user });
    return updated;
  }

  /**
   * Puts the publisher logo on the current CDN: a logo not uploaded yet, or one still stored on
   * the local test CDN from before the provider was switched. A logo already on the CDN is kept.
   */
  async convertLogoToCdn(id, user = null) {
    const card = await this.requireCard(id);
    this.assertNotProcessing(card);
    const current = card.cdn_publisher_logo_url;
    if (current && !this.deps.cdn.isForeignUrl?.(current)) return card;
    let buffer = current ? await this.deps.cdn.read?.(current) : null;
    if (!buffer && card.publisher_logo_url)
      buffer = await this.deps.images.downloadLogo(card.publisher_logo_url);
    if (!buffer)
      throw new HttpError(
        400,
        "This card has no publisher logo to convert. Add a logo URL or upload a logo first.",
      );
    const stored = await storeLogo(this.deps, buffer, card.publisher_logo_url ?? undefined);
    const { cdn_publisher_logo_url: cdnUrl = stored } = await convertToCdnFields(this.deps, {
      ...card,
      image_variants: {},
      cdn_image_url: null,
      original_image_url: null,
      cdn_publisher_logo_url: stored,
    });
    const updated = await this.repo.updateCard(id, { cdn_publisher_logo_url: cdnUrl });
    if (!updated) throw new HttpError(404, "News card not found.");
    await this.event(id, "logo_converted", { actor: user });
    return updated;
  }

  /**
   * "Convert to CDN": saves the crops the editor applied (`imageFocus`, as image_focus in
   * updateCard; undefined keeps the current ones), then uploads everything still stored locally
   * (the three images, an uploaded original and the publisher logo) and switches the card to the
   * CDN URLs. A logo that cannot be uploaded does not stop the images; it is reported as
   * `logo_error`.
   */
  async convertToCdn(id, imageFocus, user = null) {
    const card = await this.requireCard(id);
    this.assertNotProcessing(card);
    if (!this.deps.cdn.configured)
      throw new HttpError(400, "The CDN is not configured (set CDN_PROVIDER and CDN_* variables).");

    const patch = {};
    let recropped = false;
    let logoError = null;
    try {
      if (imageFocus !== undefined) {
        const current = card.image_focus ?? null;
        const focus = imageFocus === null ? null : mergeFocus(current, imageFocus);
        if (!sameFocus(focus, current) || !card.cdn_image_url) {
          if (!card.original_image_url)
            throw new HttpError(
              400,
              "This card has no original image to re-crop. Upload the image again first.",
            );
          const buffer =
            (await this.deps.cdn.read?.(card.original_image_url)) ??
            (await this.deps.images.download(card.original_image_url)).buffer;
          const result = await processVariants(
            this.deps,
            buffer,
            card.original_image_url,
            undefined,
            focus,
          );
          Object.assign(patch, imageFields(result, card.cdn_image_source), { image_focus: focus });
          recropped = true;
        }
      }
      // A logo found on the article but never stored (e.g. its download failed) is tried again.
      if (!card.cdn_publisher_logo_url && card.publisher_logo_url) {
        try {
          const buffer = await this.deps.images.downloadLogo(card.publisher_logo_url);
          patch.cdn_publisher_logo_url = await storeLogo(this.deps, buffer, card.publisher_logo_url);
        } catch (err) {
          logoError = toPipelineError(err).message;
        }
      }
      Object.assign(patch, await convertToCdnFields(this.deps, { ...card, ...patch }));
      if (!Object.keys(patch).length) return { card, logo_error: logoError };

      const after = { ...card, ...patch };
      const updated = await this.repo.updateCard(id, {
        ...patch,
        // New crops need approval again; uploading the same images does not.
        ...(recropped
          ? this.statusAfterManualChange(card, after)
          : { missing_fields: computeMissingFields(after) }),
      });
      if (!updated) throw new HttpError(404, "News card not found.");
      await this.event(id, "converted_to_cdn", {
        status: updated.status,
        actor: user,
        message: recropped
          ? "New crops saved; images and logo uploaded to the CDN."
          : "Images and logo uploaded to the CDN.",
      });
      return { card: updated, logo_error: logoError };
    } catch (err) {
      throw asHttpError(err);
    }
  }

  // ── Review, publishing and export ──────────────────────────────────────────

  async approve(ids, user) {
    const cards = new Map(
      (await this.repo.getCardsByIds(ids)).map((c) => [c.id, c]),
    );
    const approved = [];
    const rejected = [];
    for (const id of ids) {
      const card = cards.get(id);
      if (!card) {
        rejected.push({ id, reason: "Card not found.", next_action: "none" });
        continue;
      }
      const blocker = approvalBlocker(card, localImageUrls(this.deps, card).length > 0);
      if (blocker) {
        rejected.push({ id, ...blocker });
        continue;
      }
      const updated = await this.repo.updateCard(id, {
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_by: user,
        missing_fields: [],
      });
      if (!updated) continue;
      await this.event(id, "approved", { status: "approved", actor: user });
      approved.push(updated);
    }
    return { approved, rejected };
  }

  /**
   * Records an editor's confirmation that the exported HTML is live on the website. There is no
   * website publishing integration, so the system never sets "published" on its own.
   */
  async markPublished(ids, user = null) {
    const cards = new Map(
      (await this.repo.getCardsByIds(ids)).map((c) => [c.id, c]),
    );
    const published = [];
    const rejected = [];
    for (const id of ids) {
      const card = cards.get(id);
      if (!card) rejected.push({ id, reason: "Card not found." });
      else if (card.status !== "approved")
        rejected.push({
          id,
          reason: "Approve the card before saving the final changes.",
        });
      else if (computeMissingFields(card).length)
        rejected.push({ id, reason: "The card is incomplete." });
      else if (localImageUrls(this.deps, card).length)
        rejected.push({
          id,
          reason: "The images are only stored locally. Click Convert to CDN in the editor first.",
        });
      else {
        const updated = await this.repo.updateCard(id, {
          status: "published",
          site_published_at: new Date().toISOString(),
          live_card: this.liveSnapshot(card),
        });
        if (!updated) continue;
        await this.event(id, "published_confirmed", {
          status: "published",
          actor: user,
          message: card.live_card
            ? "Final changes saved; the website now shows this version."
            : "Final changes saved; the card is now on the website.",
        });
        published.push(updated);
      }
    }
    return { published, rejected };
  }

  /** Takes cards off the website. The cards themselves are kept and can be saved again. */
  async unpublish(ids, user = null) {
    const cards = new Map(
      (await this.repo.getCardsByIds(ids)).map((c) => [c.id, c]),
    );
    const removed = [];
    const rejected = [];
    for (const id of ids) {
      const card = cards.get(id);
      if (!card) rejected.push({ id, reason: "Card not found." });
      else if (!card.live_card)
        rejected.push({ id, reason: "This card is not on the website." });
      else {
        const updated = await this.repo.updateCard(id, {
          live_card: null,
          site_published_at: null,
          ...(card.status === "published" && { status: "approved" }),
        });
        if (!updated) continue;
        await this.event(id, "unpublished", {
          status: updated.status,
          actor: user,
          message: "Removed from the website.",
        });
        removed.push(updated);
      }
    }
    return { removed, rejected };
  }

  /**
   * The version of a card the website shows: the article details, the three images and the
   * ready-made HTML of each card design. Saved as a copy, so later edits are not live until
   * they are approved and saved again.
   */
  liveSnapshot(card) {
    const { article, outputs } = buildCardOutputs(card, {
      date: this.deps.dateFormat,
      publisherLogo: this.deps.showPublisherLogo,
    });
    return {
      ...article,
      images: Object.fromEntries(outputs.map((o) => [o.variant, o.image])),
      html: Object.fromEntries(outputs.map((o) => [o.variant, o.html])),
    };
  }

  // ── Public (website) API ───────────────────────────────────────────────────

  async listLiveNews({ limit, offset }) {
    const { items, total } = await this.repo.listLiveCards({ limit, offset });
    return { items: items.map(toPublicNews), total, limit, offset };
  }

  async getLiveNews(id) {
    const row = await this.repo.getLiveCard(id);
    if (!row) throw new HttpError(404, "This news card is not on the website.");
    return toPublicNews(row);
  }

  async exportHtml(ids, options) {
    const cards = new Map(
      (await this.repo.getCardsByIds(ids)).map((c) => [c.id, c]),
    );
    const included = [];
    const skipped = [];
    for (const id of ids) {
      const card = cards.get(id);
      if (!card) skipped.push({ id, reason: "Card not found." });
      else if (!EXPORTABLE_STATUSES.includes(card.status))
        skipped.push({
          id,
          reason: "Only approved or published cards can be exported.",
        });
      else if (computeMissingFields(card).length)
        skipped.push({ id, reason: "The card is incomplete." });
      else included.push(card);
    }
    if (!included.length)
      throw new HttpError(
        400,
        "None of the selected cards can be exported. Approve them first.",
        { skipped },
      );

    const html = generateExportHtml(included, {
      date: this.deps.dateFormat,
      publisherLogo: this.deps.showPublisherLogo,
      includeStyles: options.includeStyles,
      format: options.format,
      variant: options.variant,
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return {
      html,
      filename: `mu-news-cards-${options.variant ?? "large"}-${stamp}.html`,
      included: included.map((c) => c.id),
      skipped,
    };
  }
}
