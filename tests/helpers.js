/**
 * Shared fixtures: a full pipeline + service wired to an in-memory repository, a mocked image
 * host and a mocked CDN. No real publisher or CDN is ever contacted by the test suite.
 */
import sharp from "sharp";
import { vi } from "vitest";
import { PipelineError } from "../server/lib/errors.js";
import { logger } from "../server/lib/logger.js";
import { LocalDevCdnAdapter } from "../server/services/cdnAdapter.js";
import { ImageService } from "../server/services/imageProcessor.js";
import { MemoryRepository } from "../server/services/memoryRepository.js";
import { NewsService } from "../server/services/newsService.js";
import { createPipeline } from "../server/services/pipeline.js";
import { ProcessingQueue } from "../server/services/processingQueue.js";

export const ARTICLE = "https://news.example.com/story-1";

export const IMAGE_SPEC = {
  width: 800,
  height: 450,
  fit: "cover",
  position: "centre",
  format: "webp",
  quality: 80,
  background: "#fff",
  minSourceWidth: 200,
  minSourceHeight: 100,
};

export function extraction(overrides = {}) {
  return {
    metadata: {
      title: "A complete article title",
      description: "Complete description",
      publisher: "Example News",
      publishedAt: "2026-10-10T04:00:00.000Z",
      imageUrl: "https://img.example.com/featured.jpg",
      canonicalUrl: ARTICLE,
    },
    imageCandidates: ["https://img.example.com/featured.jpg"],
    method: "metadata",
    finalUrl: ARTICLE,
    blocked: null,
    warnings: [],
    fieldSources: {},
    ...overrides,
  };
}

/** Builds the pipeline. `options.upload(input, callIndex)` may override the mocked CDN. */
export async function setup(options = {}) {
  const repo = options.repo ?? new MemoryRepository();
  const imageBytes = await sharp({
    create: { width: 1200, height: 700, channels: 3, background: "#336699" },
  })
    .jpeg()
    .toBuffer();
  const fetcher = vi.fn(async (url) => ({
    url,
    status: 200,
    headers: {},
    contentType: "image/jpeg",
    body: imageBytes,
    truncated: false,
    redirects: [],
  }));
  const images = new ImageService(
    { ...IMAGE_SPEC, ...options.imageSpec },
    fetcher,
    {
      timeoutMs: 1000,
      maxBytes: 5_000_000,
      maxRedirects: 2,
      userAgent: "test",
    },
  );
  let cdnFailures = options.cdnFailures ?? 0;
  let calls = 0;
  const upload = vi.fn(async (input) => {
    const index = calls++;
    if (options.upload) {
      const result = await options.upload(input, index);
      if (result) return result;
    }
    if (cdnFailures-- > 0)
      throw new PipelineError("CDN_UPLOAD_FAILED", "CDN down", {
        retryable: true,
      });
    return {
      url: `https://cdn.example.com/${input.filename}`,
      provider: "test",
    };
  });
  const cdn = { name: "test", configured: true, inputMode: "file", upload };
  // With `localDir`, images are kept in a local store until Convert to CDN, as in the app.
  if (options.localDir) {
    const local = new LocalDevCdnAdapter(options.localDir, "http://localhost:8787");
    cdn.local = local;
    cdn.read = (url) => local.read(url);
    cdn.isForeignUrl = (url) => local.owns(url);
  }
  const extract = vi.fn(options.extract ?? (async () => extraction()));

  let service;
  const queue = new ProcessingQueue({
    concurrency: 3,
    maxRetries: options.maxRetries ?? 2,
    baseDelayMs: 1,
    run: createPipeline({
      repo,
      extractor: { extract },
      images,
      cdn,
      cdnFilenamePrefix: "news-card",
      logger,
    }),
    onRetry: (t, e, d) => service.handleRetryScheduled(t, e, d),
    onFailure: (t, e) => service.handleJobFailure(t, e),
  });
  service = new NewsService({
    repo,
    queue,
    images,
    cdn,
    cdnFilenamePrefix: "news-card",
    maxBatchSize: 20,
    dateFormat: { locale: "en-US", month: "short", timeZone: "Asia/Kolkata" },
    logger,
  });
  return { repo, service, queue, extract, upload, fetcher, images };
}
