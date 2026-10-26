import { describe, expect, it, vi } from "vitest";
import { PipelineError } from "../server/lib/errors.js";
import { ProcessingQueue } from "../server/services/processingQueue.js";
import { ARTICLE, extraction, setup } from "./helpers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("ProcessingQueue", () => {
  it("respects the concurrency limit and keeps processing after failures", async () => {
    let running = 0;
    let peak = 0;
    const done = [];
    const failures = [];
    const queue = new ProcessingQueue({
      concurrency: 3,
      maxRetries: 0,
      baseDelayMs: 0,
      run: async (task) => {
        running++;
        peak = Math.max(peak, running);
        await sleep(10);
        running--;
        if (task.cardId === "c2") throw new PipelineError("NOT_FOUND", "gone");
        done.push(task.cardId);
      },
      onFailure: (task) => void failures.push(task.cardId),
    });
    for (let i = 1; i <= 8; i++) queue.enqueue(`c${i}`);
    await queue.onIdle();
    expect(peak).toBe(3);
    expect(failures).toEqual(["c2"]);
    expect(done).toHaveLength(7);
  });

  it("retries transient errors with bounded attempts, never permanent ones", async () => {
    const attempts = {};
    const onFailure = vi.fn();
    const onRetry = vi.fn();
    const queue = new ProcessingQueue({
      concurrency: 2,
      maxRetries: 2,
      baseDelayMs: 1,
      run: async (task) => {
        attempts[task.cardId] = task.attempt;
        if (task.cardId === "flaky" && task.attempt < 2)
          throw new PipelineError("TIMEOUT", "slow", { retryable: true });
        if (task.cardId === "down")
          throw new PipelineError("NETWORK", "down", { retryable: true });
        if (task.cardId === "blocked")
          throw new PipelineError("NOT_FOUND", "404");
      },
      onRetry,
      onFailure,
    });
    ["flaky", "down", "blocked"].forEach((id) => queue.enqueue(id));
    await queue.onIdle();
    expect(attempts).toEqual({ flaky: 2, down: 3, blocked: 1 });
    expect(onFailure.mock.calls.map(([t]) => t.cardId).sort()).toEqual([
      "blocked",
      "down",
    ]);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it("ignores duplicate enqueues and cancels jobs that have not started", async () => {
    const ran = [];
    const queue = new ProcessingQueue({
      concurrency: 1,
      maxRetries: 0,
      baseDelayMs: 0,
      run: async (task) => {
        await sleep(5);
        ran.push(task.cardId);
      },
      onFailure: () => undefined,
    });
    expect(queue.enqueue("a")).toBe(true);
    expect(queue.enqueue("a")).toBe(false);
    queue.enqueue("b");
    queue.enqueue("c");
    await sleep(0);
    expect(queue.cancel("a")).toBe("running");
    expect(queue.cancel("c")).toBe("cancelled");
    await queue.onIdle();
    expect(ran).toEqual(["a", "b"]);
  });
});

// ── Pipeline + service integration with an in-memory repository ──

describe("pipeline", () => {
  it("processes a batch end to end and stores the CDN URL", async () => {
    const { repo, service, queue } = await setup();
    const result = await service.submitBatch([ARTICLE], "editor@example.com");
    await queue.onIdle();
    const card = await repo.getCard(result.queued[0].id);
    expect(card.status).toBe("completed");
    expect(card.cdn_image_url).toMatch(
      /^https:\/\/cdn\.example\.com\/news-card-[0-9a-f]{20}\.webp$/,
    );
    expect(card.original_image_url).toBe(
      "https://img.example.com/featured.jpg",
    );
    expect(card.missing_fields).toEqual([]);
  });

  it("de-duplicates within a batch, against the library, and by canonical URL", async () => {
    const { repo, service, queue } = await setup({
      extract: async () => extraction(),
    });
    const first = await service.submitBatch(
      [
        ARTICLE,
        `${ARTICLE}/?utm_source=x`,
        "https://www.news.example.com/story-1#c",
      ],
      null,
    );
    expect(first.queued).toHaveLength(1);
    expect(first.skipped.map((s) => s.reason)).toEqual([
      "duplicate_in_batch",
      "duplicate_in_batch",
    ]);
    await queue.onIdle();

    const again = await service.submitBatch([ARTICLE], null);
    expect(again.batch).toBeNull();
    expect(again.skipped[0].reason).toBe("already_exists");

    // A different URL (e.g. AMP) whose canonical is the same article becomes a duplicate, not a second card.
    const amp = await service.submitBatch(
      ["https://news.example.com/amp/story-1"],
      null,
    );
    await queue.onIdle();
    const ampCard = await repo.getCard(amp.queued[0].id);
    expect(ampCard.status).toBe("duplicate");
    expect(ampCard.duplicate_of).toBe(first.queued[0].id);
    expect(
      [...repo.cards.values()].filter((c) => c.status !== "duplicate"),
    ).toHaveLength(1);
  });

  it("retries CDN failures without re-extracting or duplicating uploads", async () => {
    const { repo, service, queue, extract, upload } = await setup({
      cdnFailures: 1,
    });
    const { queued } = await service.submitBatch([ARTICLE], null);
    await queue.onIdle();
    const card = await repo.getCard(queued[0].id);
    expect(card.status).toBe("completed");
    expect(card.attempts).toBe(2);
    expect(upload).toHaveBeenCalledTimes(4); // 1 failure + large, medium, small
    expect(extract).toHaveBeenCalledTimes(2);

    // Manual retry of a completed card is refused; partial cards resume without re-uploading.
    await expect(service.retryCard(card.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("reuses cached CDN uploads for identical images across cards", async () => {
    const { service, queue, upload } = await setup({
      extract: async () =>
        extraction({
          metadata: { ...extraction().metadata, canonicalUrl: null },
        }),
    });
    await service.submitBatch(
      [ARTICLE, "https://news.example.com/story-2"],
      null,
    );
    await queue.onIdle();
    expect(upload).toHaveBeenCalledTimes(3); // one upload per variant, shared by both cards
  });

  it("routes blocked publishers to verification and resumes after manual completion", async () => {
    const { repo, service, queue, extract } = await setup({
      extract: async () =>
        extraction({
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
          blocked: {
            kind: "captcha",
            reason: "The publisher requires a CAPTCHA.",
          },
        }),
    });
    const { queued } = await service.submitBatch([ARTICLE], null);
    await queue.onIdle();
    let card = await repo.getCard(queued[0].id);
    expect(card.status).toBe("verification_required");
    expect(card.verification_reason).toMatch(/CAPTCHA/);
    expect(extract).toHaveBeenCalledTimes(1); // blocked pages are not auto-retried

    card = await service.updateCard(card.id, {
      title: "Manually entered title",
      description: "Manual description",
      publisher: "Example News",
      published_at: "2026-10-11",
      original_image_url: "https://img.example.com/manual.jpg",
    });
    expect(card.status).toBe("queued");
    expect(card.extraction_method).toBe("manual");
    await queue.onIdle();
    card = await repo.getCard(card.id);
    expect(card.status).toBe("completed");
    expect(card.cdn_image_url).toBeTruthy();
    expect(extract).toHaveBeenCalledTimes(1); // resume skips extraction
  });

  it("keeps partial data when a field is missing and requires explicit approval", async () => {
    const { repo, service, queue } = await setup({
      extract: async () =>
        extraction({
          metadata: { ...extraction().metadata, description: null },
        }),
    });
    const { queued } = await service.submitBatch(
      [ARTICLE],
      "editor@example.com",
    );
    await queue.onIdle();
    const id = queued[0].id;
    expect((await repo.getCard(id)).status).toBe("partial_data");

    const refused = await service.approve([id], "editor@example.com");
    expect(refused.rejected[0].reason).toMatch(/Description/);

    await service.updateCard(id, { description: "Added by an editor" });
    expect((await repo.getCard(id)).status).toBe("completed");
    const { approved } = await service.approve([id], "editor@example.com");
    expect(approved[0]).toMatchObject({
      status: "approved",
      approved_by: "editor@example.com",
    });

    const exported = await service.exportHtml([id], {
      includeStyles: true,
      format: "snippet",
    });
    expect(exported.html).toContain('class="newsCard"');
    expect(exported.html).toContain("Added by an editor");
    expect(exported.html).toContain("-webkit-line-clamp: 2");
  });

  it("refuses to export unapproved cards", async () => {
    const { service, queue } = await setup();
    const { queued } = await service.submitBatch([ARTICLE], null);
    await queue.onIdle();
    await expect(
      service.exportHtml([queued[0].id], {
        includeStyles: false,
        format: "snippet",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("marks permanent failures as failed with the error and lets bulk retry skip them", async () => {
    const { repo, service, queue } = await setup({
      extract: async () => {
        throw new PipelineError(
          "NOT_FOUND",
          "The article is unavailable (HTTP 404).",
        );
      },
    });
    const { batch, queued } = await service.submitBatch([ARTICLE], null);
    await queue.onIdle();
    const card = await repo.getCard(queued[0].id);
    expect(card).toMatchObject({
      status: "failed",
      error_code: "NOT_FOUND",
      attempts: 1,
    });
    expect((await service.retryBatch(batch.id)).retried).toEqual([]);
  });
});
