/**
 * End-to-end workflow: one article → one master record → three card outputs, CAPTCHA handling,
 * bulk approval/retry, partial CDN failures, edits, logos, restart recovery and the event log.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PipelineError } from "../server/lib/errors.js";
import { MAX_BLOCKED_ATTEMPTS } from "../shared/types.js";
import { ARTICLE, extraction, setup } from "./helpers.js";

const BLOCKED = {
  metadata: {
    title: null,
    description: null,
    publisher: null,
    publishedAt: null,
    imageUrl: null,
    canonicalUrl: null,
  },
  imageCandidates: [],
  method: null,
  blocked: { kind: "captcha", reason: "The publisher requires a CAPTCHA." },
};

async function processOne(ctx, url = ARTICLE) {
  const { queued } = await ctx.service.submitBatch([url], "editor@example.com");
  await ctx.queue.onIdle();
  return ctx.repo.getCard(queued[0].id);
}

describe("one article, three card outputs", () => {
  it("creates one master record with large, medium and small CDN variants", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);

    expect(ctx.repo.cards.size).toBe(1);
    expect(card.status).toBe("completed");
    expect(Object.keys(card.image_variants)).toEqual([
      "large",
      "medium",
      "small",
    ]);
    expect(card.cdn_image_url).toBe(card.image_variants.large.url);

    const sizes = await Promise.all(
      ctx.upload.mock.calls.map(async ([input]) => {
        const meta = await sharp(input.buffer).metadata();
        return [meta.format, meta.width, meta.height];
      }),
    );
    expect(sizes).toEqual([
      ["webp", 800, 450],
      ["webp", 758, 676],
      ["webp", 488, 340],
    ]);
    expect(card.image_variants.medium).toMatchObject({ width: 758, height: 676 });
  });

  it("re-adding the same canonical URL does not create another record", async () => {
    const ctx = await setup();
    await processOne(ctx);
    const again = await ctx.service.submitBatch(
      [`${ARTICLE}?utm_source=newsletter`],
      null,
    );
    expect(again.batch).toBeNull();
    expect(again.skipped[0].reason).toBe("already_exists");
    expect(ctx.repo.cards.size).toBe(1);
  });

  it("binds the same metadata to all three outputs, differing only in the image", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    const { article, outputs } = await ctx.service.getOutputs(card.id);

    expect(article).toMatchObject({
      title: "A complete article title",
      publisher: "Example News",
      article_url: ARTICLE,
      publish_date_label: "Oct 10, 2026",
    });
    expect(outputs.map((o) => o.variant)).toEqual(["large", "medium", "small"]);
    const urls = outputs.map((o) => o.image.url);
    expect(new Set(urls).size).toBe(3);
    outputs.forEach((o) => expect(o.html).toContain(`src="${o.image.url}"`));

    // Each output renders its own design with the same metadata.
    expect(outputs.map((o) => o.design)).toEqual(["standard", "feature", "list"]);
    expect(outputs[0].html).toContain('<div class="newsCard">');
    expect(outputs[1].html).toContain('<a class="newsCardFeature"');
    expect(outputs[2].html).toContain('<div class="newsCardList">');
    outputs.forEach((o) => {
      expect(o.html).toContain("A complete article title");
      expect(o.html).toContain(`href="${ARTICLE}"`);
    });
  });

  it("updates every output when an editor changes the metadata", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    await ctx.service.approve([card.id], "editor@example.com");

    const edited = await ctx.service.updateCard(
      card.id,
      { title: "Corrected <headline>" },
      "editor@example.com",
    );
    expect(edited.status).toBe("needs_review"); // an edit after approval needs re-approval
    const { outputs } = await ctx.service.getOutputs(card.id);
    outputs.forEach((o) =>
      expect(o.html).toContain("Corrected &lt;headline&gt;"),
    );
  });

  it("regenerates all variants when the featured image changes", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    const queued = await ctx.service.updateCard(card.id, {
      original_image_url: "https://img.example.com/replacement.jpg",
    });
    expect(queued.status).toBe("queued");
    expect(queued.image_variants).toEqual({});
    await ctx.queue.onIdle();
    const done = await ctx.repo.getCard(card.id);
    expect(done.status).toBe("completed");
    expect(Object.keys(done.image_variants)).toHaveLength(3);
    expect(done.original_image_url).toBe(
      "https://img.example.com/replacement.jpg",
    );
  });

  it("re-crops only the card whose focus point changed and needs approval again", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    await ctx.service.approve([card.id], "editor@example.com");
    const before = card.image_variants;
    const uploads = ctx.upload.mock.calls.length;

    const queued = await ctx.service.updateCard(card.id, {
      image_focus: { medium: { x: 0.2, y: 0.4 } },
    });
    expect(queued.status).toBe("queued");
    expect(queued.approved_at).toBeNull();
    await ctx.queue.onIdle();
    const done = await ctx.repo.getCard(card.id);
    expect(done.image_focus).toEqual({ medium: { x: 0.2, y: 0.4 } });
    expect(done.image_variants.medium.url).not.toBe(before.medium.url);
    // The other cards keep their crop and are not uploaded again.
    expect(done.image_variants.large.url).toBe(before.large.url);
    expect(done.image_variants.small.url).toBe(before.small.url);
    expect(ctx.upload.mock.calls.length).toBe(uploads + 1);

    // Points are merged per card; null sends one card back to the automatic crop.
    await ctx.service.updateCard(card.id, { image_focus: { small: { x: 1, y: 0 } } });
    await ctx.queue.onIdle();
    expect((await ctx.repo.getCard(card.id)).image_focus).toEqual({
      medium: { x: 0.2, y: 0.4 },
      small: { x: 1, y: 0 },
    });
    await ctx.service.updateCard(card.id, { image_focus: { medium: null } });
    await ctx.queue.onIdle();
    expect((await ctx.repo.getCard(card.id)).image_focus).toEqual({ small: { x: 1, y: 0 } });

    // Sending the same points again changes nothing.
    const same = await ctx.service.updateCard(card.id, { image_focus: { small: { x: 1, y: 0 } } });
    expect(same.status).not.toBe("queued");

    // Choosing another image drops every focus point.
    const replaced = await ctx.service.updateCard(card.id, {
      original_image_url: "https://img.example.com/replacement.jpg",
      image_focus: { large: { x: 0.9, y: 0.9 } },
    });
    expect(replaced.image_focus).toBeNull();
  });

  it("previews crops without uploading until they are converted to the CDN", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    const uploads = ctx.upload.mock.calls.length;

    const preview = await ctx.service.previewCrop(card.id, { medium: { x: 0.2, y: 0.4 } });
    expect(preview.image_focus).toEqual({ medium: { x: 0.2, y: 0.4 } });
    for (const key of ["large", "medium", "small"])
      expect(preview.variants[key].url).toMatch(/^data:image\//);
    expect(ctx.upload.mock.calls.length).toBe(uploads);
    const unchanged = await ctx.repo.getCard(card.id);
    expect(unchanged.image_focus ?? null).toBeNull();
    expect(unchanged.image_variants).toEqual(card.image_variants);

    // Converting saves the previewed crops; only the changed card is uploaded.
    await ctx.service.updateCard(card.id, { image_focus: preview.image_focus });
    await ctx.queue.onIdle();
    const done = await ctx.repo.getCard(card.id);
    expect(done.image_focus).toEqual({ medium: { x: 0.2, y: 0.4 } });
    expect(done.image_variants.medium.url).not.toBe(card.image_variants.medium.url);
    expect(ctx.upload.mock.calls.length).toBe(uploads + 1);
  });

  it("keeps images and logo local until Convert to CDN, then switches to the CDN links", async () => {
    const localDir = await mkdtemp(path.join(os.tmpdir(), "local-images-"));
    try {
      const meta = extraction().metadata;
      const ctx = await setup({
        localDir,
        extract: async () =>
          extraction({ metadata: { ...meta, publisherLogoUrl: "https://example.com/logo.png" } }),
      });
      const card = await processOne(ctx);
      expect(ctx.upload).not.toHaveBeenCalled();
      for (const key of ["large", "medium", "small"])
        expect(card.image_variants[key].url).toMatch(/^http:\/\/localhost:8787\/dev-cdn\//);
      expect(card.cdn_publisher_logo_url).toMatch(/\/dev-cdn\/news-card-logo-/);

      // Not approvable while the images are only local.
      const approval = await ctx.service.approve([card.id], "editor");
      expect(approval.rejected[0]).toMatchObject({ next_action: "convert_to_cdn" });

      // Convert saves the applied crop (re-cropped locally) and uploads everything.
      const { card: converted, logo_error } = await ctx.service.convertToCdn(
        card.id,
        { medium: { x: 0.1, y: 0.1, w: 0.5, h: 0.5, fit: "crop" } },
        "editor",
      );
      expect(logo_error).toBeNull();
      expect(converted.image_focus).toEqual({ medium: { x: 0.1, y: 0.1, w: 0.5, h: 0.5, fit: "crop" } });
      for (const key of ["large", "medium", "small"])
        expect(converted.image_variants[key].url).toMatch(/^https:\/\/cdn\.example\.com\//);
      expect(converted.cdn_image_url).toBe(converted.image_variants.large.url);
      expect(converted.cdn_publisher_logo_url).toMatch(/^https:\/\/cdn\.example\.com\/news-card-logo-/);
      expect(ctx.upload).toHaveBeenCalledTimes(4);
      expect((await ctx.service.approve([card.id], "editor")).approved).toHaveLength(1);

      // Everything is on the CDN: converting again uploads nothing.
      await ctx.service.convertToCdn(card.id, undefined, "editor");
      expect(ctx.upload).toHaveBeenCalledTimes(4);
    } finally {
      await rm(localDir, { recursive: true, force: true });
    }
  });

  it("keeps an uploaded original so it can be re-cropped later", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    const file = await sharp({
      create: { width: 1000, height: 600, channels: 3, background: "#123456" },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await ctx.service.uploadThumbnail(card.id, file);
    expect(uploaded.original_image_url).toMatch(/^https:\/\/cdn\.example\.com\/.*-original-.*\.jpg$/);
    expect(uploaded.image_focus).toBeNull();
  });

  it("generates the missing variants for a legacy card that only has the large image", async () => {
    const ctx = await setup({
      extract: async () =>
        extraction({
          metadata: { ...extraction().metadata, imageUrl: null },
          imageCandidates: [],
        }),
    });
    const [card] = await ctx.repo.insertCards([
      {
        batch_id: null,
        source_url: ARTICLE,
        source_url_key: "news.example.com/story-1",
        status: "partial_data",
        processing_stage: "done",
        cdn_image_url: "https://cdn.example.com/legacy.webp",
        cdn_image_source: "upload:abc",
      },
    ]);
    await ctx.service.retryCard(card.id);
    await ctx.queue.onIdle();
    const done = await ctx.repo.getCard(card.id);
    expect(done.status).toBe("completed");
    expect(Object.keys(done.image_variants)).toHaveLength(3);
    expect(done.cdn_image_source).toBe("upload:abc");
    expect(ctx.fetcher.mock.calls[0][0]).toBe(
      "https://cdn.example.com/legacy.webp",
    );
  });
});

describe("publisher logos", () => {
  it("stores a manually uploaded logo separately from the featured image", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    const logo = await sharp({
      create: {
        width: 240,
        height: 80,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const updated = await ctx.service.uploadLogo(card.id, logo, "editor");
    expect(updated.cdn_publisher_logo_url).toMatch(
      /^https:\/\/cdn\.example\.com\/news-card-logo-[0-9a-f]{20}\.webp$/,
    );
    expect(updated.image_variants).toEqual(card.image_variants);
    expect(Object.values(updated.image_variants).map((v) => v.url)).not.toContain(
      updated.cdn_publisher_logo_url,
    );
    const { article } = await ctx.service.getOutputs(card.id);
    expect(article.publisher_logo_url).toBe(updated.cdn_publisher_logo_url);
  });

  it("moves a logo left on the local test CDN to the current CDN, ignoring the stale cache", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    const logo = await sharp({
      create: { width: 240, height: 80, channels: 4, background: "#123456" },
    })
      .png()
      .toBuffer();
    // The logo was uploaded while CDN_PROVIDER=local-dev, then the provider was switched.
    const localUrl = "http://localhost:8787/dev-cdn/news-card-logo-old.webp";
    const uploaded = await ctx.service.uploadLogo(card.id, logo, "editor");
    for (const record of ctx.repo.images.values())
      if (record.cdn_url === uploaded.cdn_publisher_logo_url) record.cdn_url = localUrl;
    await ctx.repo.updateCard(card.id, { cdn_publisher_logo_url: localUrl });
    const cdn = ctx.service.deps.cdn;
    cdn.read = async (url) => (url === localUrl ? logo : null);
    cdn.isForeignUrl = (url) => url.includes("/dev-cdn/");
    const uploads = ctx.upload.mock.calls.length;

    const updated = await ctx.service.convertLogoToCdn(card.id, "editor");
    expect(updated.cdn_publisher_logo_url).toBe(uploaded.cdn_publisher_logo_url);
    expect(ctx.upload.mock.calls.length).toBe(uploads + 1);

    // Already on the CDN: nothing is uploaded again.
    await ctx.service.convertLogoToCdn(card.id, "editor");
    expect(ctx.upload.mock.calls.length).toBe(uploads + 1);
  });
});

describe("CAPTCHA, approval and retry", () => {
  it("flags CAPTCHA pages, explains the next step on approval and caps retries", async () => {
    const ctx = await setup({ extract: async () => extraction(BLOCKED) });
    let card = await processOne(ctx);
    expect(card.status).toBe("verification_required");

    const approval = await ctx.service.approve([card.id], "editor");
    expect(approval.approved).toEqual([]);
    expect(approval.rejected[0]).toMatchObject({
      next_action: "complete_manually",
    });
    expect((await ctx.repo.getCard(card.id)).status).toBe(
      "verification_required",
    );

    for (let i = card.attempts; i < MAX_BLOCKED_ATTEMPTS; i++) {
      await ctx.service.retryCard(card.id);
      await ctx.queue.onIdle();
    }
    card = await ctx.repo.getCard(card.id);
    expect(card.attempts).toBe(MAX_BLOCKED_ATTEMPTS);
    await expect(ctx.service.retryCard(card.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/manually/),
    });
    expect(ctx.extract).toHaveBeenCalledTimes(MAX_BLOCKED_ATTEMPTS);
  });

  it("reports per-article results for bulk approve and bulk retry", async () => {
    let call = 0;
    const ctx = await setup({
      extract: async () => {
        call++;
        if (call === 2)
          throw new PipelineError("TIMEOUT", "Timed out.", { retryable: false });
        return extraction({
          metadata: {
            ...extraction().metadata,
            canonicalUrl: null,
          },
        });
      },
    });
    const { queued } = await ctx.service.submitBatch(
      [ARTICLE, "https://news.example.com/story-2"],
      null,
    );
    await ctx.queue.onIdle();
    const [ok, failed] = queued.map((c) => c.id);
    expect((await ctx.repo.getCard(failed)).status).toBe("failed");

    const approval = await ctx.service.approve([ok, failed], "editor");
    expect(approval.approved.map((c) => c.id)).toEqual([ok]);
    expect(approval.rejected).toEqual([
      expect.objectContaining({ id: failed, next_action: "retry_or_edit" }),
    ]);

    const retry = await ctx.service.retryCards([ok, failed], "editor");
    expect(retry.retried.map((c) => c.id)).toEqual([failed]);
    expect(retry.rejected).toEqual([
      expect.objectContaining({ id: ok, reason: expect.stringMatching(/Approved/) }),
    ]);
    await ctx.queue.onIdle();
    expect((await ctx.repo.getCard(failed)).status).toBe("completed");
  });

  it("never marks a card published until an editor confirms it", async () => {
    const ctx = await setup();
    const card = await processOne(ctx);
    await ctx.service.approve([card.id], "editor");
    await ctx.service.exportHtml([card.id], { format: "snippet" });
    expect((await ctx.repo.getCard(card.id)).status).toBe("approved");

    const { published } = await ctx.service.markPublished([card.id], "editor");
    expect(published[0].status).toBe("published");
    const events = await ctx.service.listEvents(card.id);
    expect(events[0]).toMatchObject({
      event: "published_confirmed",
      actor: "editor",
    });
  });
});

describe("reliability", () => {
  it("recovers from a partial CDN failure without re-uploading finished variants", async () => {
    const ctx = await setup({
      upload: (_input, index) => {
        if (index === 1)
          throw new PipelineError("CDN_UPLOAD_FAILED", "CDN upload failed with HTTP 400.", {
            status: 400,
          });
      },
    });
    let card = await processOne(ctx);
    expect(card).toMatchObject({
      status: "failed",
      error_code: "CDN_UPLOAD_FAILED",
      title: "A complete article title", // extracted data is kept
    });
    expect(card.image_variants).toEqual({});

    await ctx.service.retryCard(card.id);
    await ctx.queue.onIdle();
    card = await ctx.repo.getCard(card.id);
    expect(card.status).toBe("completed");
    // 2 calls in the failed run (large ok, medium failed) + medium and small on retry.
    expect(ctx.upload).toHaveBeenCalledTimes(4);
    expect(ctx.extract).toHaveBeenCalledTimes(1); // the retry resumed at the image stages
  });

  it("resumes jobs from the database after a restart", async () => {
    const first = await setup();
    const [card] = await first.repo.insertCards([
      {
        batch_id: null,
        source_url: ARTICLE,
        source_url_key: "news.example.com/story-1",
        status: "processing",
        processing_stage: "extracting",
      },
    ]);
    // A new process (service + queue) sharing only the persistent repository.
    const restarted = await setup({ repo: first.repo });
    expect(await restarted.service.recover()).toBe(1);
    await restarted.queue.onIdle();
    expect((await first.repo.getCard(card.id)).status).toBe("completed");
  });

  it("logs job events with a correlation id shared by the job", async () => {
    const ctx = await setup({ cdnFailures: 1 });
    const card = await processOne(ctx);
    const events = (await ctx.service.listEvents(card.id)).reverse();
    expect(events.map((e) => e.event)).toEqual([
      "submitted",
      "job_started",
      "extracted",
      "retry_scheduled",
      "job_started",
      "extracted",
      "images_uploaded",
      "job_finished",
    ]);
    const jobIds = new Set(
      events.filter((e) => e.event !== "submitted").map((e) => e.correlation_id),
    );
    expect(jobIds.size).toBe(1);
    expect([...jobIds][0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
