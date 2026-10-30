import sharp from "sharp";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { logger } from "../server/lib/logger.js";
import {
  createAuthMiddleware,
  isAdminEmail,
} from "../server/middleware/auth.js";
import { ImageService } from "../server/services/imageProcessor.js";
import { NewsService } from "../server/services/newsService.js";
import { MemoryRepository } from "../server/services/memoryRepository.js";

function build() {
  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "none",
    CDN_PROVIDER: "none",
  });
  const repo = new MemoryRepository();
  const queue = {
    enqueue: vi.fn(() => true),
    cancel: vi.fn(() => "not_found"),
    has: vi.fn(() => false),
  };
  const images = new ImageService(config.image, vi.fn(), {
    timeoutMs: 1000,
    maxBytes: 1_000_000,
    maxRedirects: 1,
    userAgent: "t",
  });
  const cdn = {
    name: "test",
    configured: true,
    inputMode: "file",
    upload: async (i) => ({
      url: `https://cdn.example.com/${i.filename}`,
      provider: "test",
    }),
  };
  const service = new NewsService({
    repo,
    queue,
    images,
    cdn,
    cdnFilenamePrefix: "news-card",
    maxBatchSize: config.queue.maxBatchSize,
    dateFormat: config.date,
    logger,
  });
  const app = createApp({
    config,
    service,
    auth: createAuthMiddleware({ mode: "none", adminEmails: [] }),
    publicConfig: {
      auth_mode: "none",
      storage: "memory",
      max_batch_size: 20,
      cdn_configured: true,
      cdn_provider: "test",
      image: { width: 800, height: 450, format: "webp" },
      date_format: config.date,
      browser_fallback_enabled: false,
    },
  });
  return { app, repo, queue };
}

describe("API", () => {
  it("submits a batch, reporting invalid, unsafe and duplicate links individually", async () => {
    const { app, queue } = build();
    const res = await request(app)
      .post("/api/batches")
      .send({
        urls: [
          "https://news.example.com/a",
          "https://news.example.com/a?utm_source=x",
          "http://127.0.0.1/x",
          "nope",
        ],
      })
      .expect(201);
    expect(res.body.queued).toHaveLength(1);
    expect(res.body.skipped.map((s) => s.reason).sort()).toEqual([
      "duplicate_in_batch",
      "invalid",
      "invalid",
    ]);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);

    const batch = await request(app)
      .get(`/api/batches/${res.body.batch.id}`)
      .expect(200);
    expect(batch.body.progress).toMatchObject({ total: 1, active: 1 });
  });

  it("enforces the batch size limit", async () => {
    const { app } = build();
    const urls = Array.from(
      { length: 21 },
      (_, i) => `https://news.example.com/${i}`,
    );
    const res = await request(app)
      .post("/api/batches")
      .send({ urls })
      .expect(400);
    expect(res.body.error.message).toMatch(/at most 20/);
  });

  it("validates request bodies and ids", async () => {
    const { app } = build();
    await request(app).post("/api/batches").send({ urls: [] }).expect(400);
    await request(app).get("/api/cards/not-a-uuid").expect(400);
    await request(app)
      .patch("/api/cards/00000000-0000-4000-8000-000000000000")
      .send({ evil: 1 })
      .expect(400);
    await request(app)
      .get("/api/cards/00000000-0000-4000-8000-000000000000")
      .expect(404);
  });

  it("edits, uploads a thumbnail, approves, exports and lists cards", async () => {
    const { app, repo } = build();
    const [card] = await repo.insertCards([
      {
        batch_id: null,
        source_url: "https://news.example.com/a",
        source_url_key: "news.example.com/a",
        status: "partial_data",
        processing_stage: "done",
      },
    ]);

    await request(app)
      .patch(`/api/cards/${card.id}`)
      .send({
        title: "Title",
        description: "Desc",
        publisher: "Pub",
        published_at: "2026-10-10",
      })
      .expect(200);

    const png = await sharp({
      create: { width: 900, height: 500, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    const uploaded = await request(app)
      .post(`/api/cards/${card.id}/thumbnail`)
      .attach("thumbnail", png, { filename: "a.png", contentType: "image/png" })
      .expect(200);
    expect(uploaded.body.status).toBe("completed");
    expect(uploaded.body.cdn_image_url).toMatch(
      /^https:\/\/cdn\.example\.com\/news-card-.*\.webp$/,
    );

    await request(app)
      .post(`/api/cards/${card.id}/thumbnail`)
      .attach("thumbnail", Buffer.from("<svg/>"), {
        filename: "a.svg",
        contentType: "image/svg+xml",
      })
      .expect(415);

    const approved = await request(app)
      .post("/api/cards/approve")
      .send({ ids: [card.id] })
      .expect(200);
    expect(approved.body.approved).toHaveLength(1);

    const exported = await request(app)
      .post("/api/cards/export")
      .send({ ids: [card.id], include_styles: true })
      .expect(200);
    expect(exported.body.html).toContain("<!DOCTYPE html>");
    expect(exported.body.html).toContain("Oct 10, 2026");

    const list = await request(app)
      .get("/api/cards?search=Tit&status=approved")
      .expect(200);
    expect(list.body.total).toBe(1);

    await request(app).delete(`/api/cards/${card.id}`).expect(204);
    await request(app).get(`/api/cards/${card.id}`).expect(404);
  });

  it("never starts processing from reads (listing, selecting, previewing)", async () => {
    const { app, repo, queue } = build();
    const [card] = await repo.insertCards([
      {
        batch_id: null,
        source_url: "https://news.example.com/a",
        source_url_key: "news.example.com/a",
        status: "verification_required",
        processing_stage: "done",
      },
    ]);
    await request(app).get("/api/cards?page=1").expect(200);
    await request(app).get(`/api/cards/${card.id}`).expect(200);
    const outputs = await request(app)
      .get(`/api/cards/${card.id}/outputs`)
      .expect(200);
    expect(outputs.body.outputs).toHaveLength(3);
    expect(outputs.body.ready).toBe(false);
    await request(app).get(`/api/cards/${card.id}/events`).expect(200);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("bulk-retries cards and reports each outcome", async () => {
    const { app, repo, queue } = build();
    const [failed, approved] = await repo.insertCards(
      ["a", "b"].map((slug) => ({
        batch_id: null,
        source_url: `https://news.example.com/${slug}`,
        source_url_key: `news.example.com/${slug}`,
        status: slug === "a" ? "failed" : "approved",
        processing_stage: "done",
      })),
    );
    const res = await request(app)
      .post("/api/cards/retry")
      .send({ ids: [failed.id, approved.id] })
      .expect(200);
    expect(res.body.retried.map((c) => c.id)).toEqual([failed.id]);
    expect(res.body.rejected[0]).toMatchObject({ id: approved.id });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("uploads a publisher logo and validates the export variant", async () => {
    const { app, repo } = build();
    const [card] = await repo.insertCards([
      {
        batch_id: null,
        source_url: "https://news.example.com/a",
        source_url_key: "news.example.com/a",
        status: "partial_data",
        processing_stage: "done",
      },
    ]);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#c00"/></svg>',
    );
    const res = await request(app)
      .post(`/api/cards/${card.id}/logo`)
      .attach("logo", svg, { filename: "l.svg", contentType: "image/svg+xml" })
      .expect(200);
    expect(res.body.cdn_publisher_logo_url).toMatch(/news-card-logo-.*\.webp$/);
    expect(res.body.cdn_image_url).toBeNull();

    await request(app)
      .post("/api/cards/export")
      .send({ ids: [card.id], variant: "huge" })
      .expect(400);
  });
});

describe("auth", () => {
  it("matches admin emails and domains", () => {
    expect(isAdminEmail("Editor@MastersUnion.org", ["@mastersunion.org"])).toBe(
      true,
    );
    expect(isAdminEmail("a@evil.org", ["@mastersunion.org", "b@x.com"])).toBe(
      false,
    );
  });

  it("rejects requests without a bearer token in supabase mode", async () => {
    const supabase = { auth: { getUser: vi.fn() } };
    const middleware = createAuthMiddleware({
      mode: "supabase",
      adminEmails: ["@example.com"],
      supabase,
    });
    const next = vi.fn();
    await middleware({ headers: {} }, { locals: {} }, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  it("rejects signed-in users who are not on the admin allow-list", async () => {
    const supabase = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "u1", email: "someone@elsewhere.org" } },
          error: null,
        })),
      },
    };
    const middleware = createAuthMiddleware({
      mode: "supabase",
      adminEmails: ["@example.com"],
      supabase,
    });
    const next = vi.fn();
    await middleware(
      { headers: { authorization: "Bearer token" } },
      { locals: {} },
      next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });

  it("serves only the saved version of a card on the public website API", async () => {
    const { app, repo } = build();
    const variant = (w, h) => ({ url: `https://cdn.example.com/${w}.webp`, width: w, height: h });
    const [card] = await repo.insertCards([
      {
        batch_id: null,
        source_url: "https://news.example.com/live",
        source_url_key: "news.example.com/live",
        title: "First title",
        description: "Desc",
        publisher: "Pub",
        published_at: "2026-10-10T12:00:00.000Z",
        image_variants: {
          large: variant(804, 392),
          medium: variant(758, 676),
          small: variant(488, 340),
        },
        status: "completed",
        processing_stage: "done",
      },
    ]);

    // Not on the website before "Save final changes", and only approved cards can be saved.
    let list = await request(app).get("/api/public/news").expect(200);
    expect(list.body).toMatchObject({ items: [], total: 0 });
    let saved = await request(app).post("/api/cards/publish").send({ ids: [card.id] });
    expect(saved.body.rejected).toHaveLength(1);

    await request(app).post("/api/cards/approve").send({ ids: [card.id] }).expect(200);
    saved = await request(app).post("/api/cards/publish").send({ ids: [card.id] }).expect(200);
    expect(saved.body.published[0].status).toBe("published");

    list = await request(app).get("/api/public/news?limit=5").expect(200);
    expect(list.headers["access-control-allow-origin"]).toBe("*");
    expect(list.body.total).toBe(1);
    const item = list.body.items[0];
    expect(item).toMatchObject({
      id: card.id,
      title: "First title",
      article_url: "https://news.example.com/live",
    });
    expect(item.images.small).toMatchObject({ width: 488, height: 340 });
    expect(item.html.large).toContain("First title");
    expect(item.html.small).toContain("488.webp");

    // One design per route: only that design's image and HTML.
    const small = await request(app).get("/api/public/news/small?limit=5").expect(200);
    expect(small.body).toMatchObject({ total: 1, variant: "small" });
    expect(small.body.items[0]).toMatchObject({ id: card.id, title: "First title" });
    expect(small.body.items[0].image).toMatchObject({ width: 488, height: 340 });
    expect(small.body.items[0].html).toBe(item.html.small);
    expect(small.body.items[0]).not.toHaveProperty("images");
    const medium = await request(app).get("/api/public/news/medium").expect(200);
    expect(medium.body.items[0].html).toBe(item.html.medium);
    const large = await request(app).get("/api/public/news/large").expect(200);
    expect(large.body.items[0].image).toMatchObject({ width: 804, height: 392 });
    await request(app).get("/api/public/news/huge").expect(400);

    // An edit is not live until it is approved and saved again.
    await request(app).patch(`/api/cards/${card.id}`).send({ title: "Second title" }).expect(200);
    let one = await request(app).get(`/api/public/news/${card.id}`).expect(200);
    expect(one.body.title).toBe("First title");
    await request(app).post("/api/cards/approve").send({ ids: [card.id] }).expect(200);
    await request(app).post("/api/cards/publish").send({ ids: [card.id] }).expect(200);
    one = await request(app).get(`/api/public/news/${card.id}`).expect(200);
    expect(one.body.title).toBe("Second title");

    // The CSS and embed script are public too; unknown public paths do not ask for sign-in.
    const css = await request(app).get("/api/public/news.css").expect(200);
    expect(css.headers["content-type"]).toMatch(/text\/css/);
    const js = await request(app).get("/api/public/embed.js").expect(200);
    expect(js.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    await request(app).get("/api/public/nope").expect(404);

    // Removing it takes it off the website but keeps the card.
    const removed = await request(app).post("/api/cards/unpublish").send({ ids: [card.id] }).expect(200);
    expect(removed.body.removed[0]).toMatchObject({ status: "approved", live_card: null });
    await request(app).get(`/api/public/news/${card.id}`).expect(404);
  });

  it("refuses unsafe production configuration", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", AUTH_MODE: "none" }),
    ).toThrow(/AUTH_MODE=none/);
    expect(() =>
      loadConfig({ NODE_ENV: "production", CDN_PROVIDER: "local-dev" }),
    ).toThrow(/local-dev/);
  });
});
