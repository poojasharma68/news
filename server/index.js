import { loadConfig } from "./config.js";
import { logger, setLogLevel } from "./lib/logger.js";
import { closeSafeFetch, safeFetch } from "./lib/safeFetch.js";
import { createApp } from "./app.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { ArticleExtractor } from "./services/articleExtractor.js";
import { BrowserRenderer } from "./services/browserFallback.js";
import { createCdnAdapter } from "./services/cdnAdapter.js";
import {
  BlockedHostRegistry,
  HostRateLimiter,
} from "./services/hostLimiter.js";
import { ImageService } from "./services/imageProcessor.js";
import { NewsService } from "./services/newsService.js";
import { createPipeline } from "./services/pipeline.js";
import { ProcessingQueue } from "./services/processingQueue.js";
import { MemoryRepository } from "./services/memoryRepository.js";
import {
  createSupabaseAdminClient,
  SupabaseRepository,
} from "./services/supabaseService.js";

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const supabaseConfigured = Boolean(
    config.supabase.url && config.supabase.serviceRoleKey,
  );
  if (!supabaseConfigured && config.isProduction) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.",
    );
  }
  const supabase = supabaseConfigured
    ? createSupabaseAdminClient(
        config.supabase.url,
        config.supabase.serviceRoleKey,
      )
    : undefined;
  // Sample mode (development only): without Supabase, data is kept in memory and lost on restart.
  const repo = supabase
    ? new SupabaseRepository(supabase)
    : new MemoryRepository();
  const authMode = supabase ? config.auth.mode : "none";
  if (!supabase) {
    logger.warn(
      "SAMPLE MODE: Supabase is not configured. Data is stored in memory and lost on restart; sign-in is disabled.",
    );
  }

  const limiter = new HostRateLimiter(config.fetch.publisherMinIntervalMs);
  const blockedHosts = new BlockedHostRegistry(config.fetch.blockedHostTtlMs);
  const baseFetch = {
    timeoutMs: config.fetch.timeoutMs,
    maxRedirects: config.fetch.maxRedirects,
    userAgent: config.fetch.userAgent,
  };
  const hostOf = (url) => new URL(url).hostname;

  const browser = config.browser.enabled
    ? new BrowserRenderer({
        timeoutMs: config.browser.timeoutMs,
        userAgent: config.fetch.userAgent,
        maxPages: config.browser.maxPages,
      })
    : null;

  const extractor = new ArticleExtractor({
    fetchPage: (url) =>
      limiter.schedule(hostOf(url), () =>
        safeFetch(url, {
          ...baseFetch,
          maxBytes: config.fetch.maxHtmlBytes,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          truncateOversize: true,
        }),
      ),
    fetchFeed: (url) =>
      limiter.schedule(hostOf(url), () =>
        safeFetch(url, {
          ...baseFetch,
          timeoutMs: Math.min(config.fetch.timeoutMs, 10_000),
          maxBytes: 2 * 1024 * 1024,
          accept:
            "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.8",
          truncateOversize: false,
        }),
      ),
    renderPage: browser
      ? (url) => limiter.schedule(hostOf(url), () => browser.render(url))
      : undefined,
    blockedHosts,
    rssEnabled: config.rssFallbackEnabled,
  });

  const images = new ImageService(
    config.image,
    (url, options) =>
      limiter.schedule(hostOf(url), () => safeFetch(url, options)),
    { ...baseFetch, maxBytes: config.fetch.maxImageBytes },
  );
  const cdn = createCdnAdapter(config);

  // The queue and the service reference each other through callbacks.
  let service;
  const runJob = createPipeline({
    repo,
    extractor,
    images,
    cdn,
    cdnFilenamePrefix: config.cdn.filenamePrefix,
    logger,
  });
  const queue = new ProcessingQueue({
    concurrency: config.queue.concurrency,
    maxRetries: config.queue.maxRetries,
    baseDelayMs: config.queue.retryBaseDelayMs,
    run: runJob,
    onRetry: (task, error, delay) =>
      service.handleRetryScheduled(task, error, delay),
    onFailure: (task, error) => service.handleJobFailure(task, error),
    logger,
  });
  service = new NewsService({
    repo,
    queue,
    images,
    cdn,
    cdnFilenamePrefix: config.cdn.filenamePrefix,
    maxBatchSize: config.queue.maxBatchSize,
    dateFormat: config.date,
    showPublisherLogo: config.card.showPublisherLogo,
    logger,
  });

  const auth = createAuthMiddleware({
    mode: authMode,
    adminEmails: config.auth.adminEmails,
    supabase,
  });
  const app = createApp({
    config,
    service,
    auth,
    publicConfig: {
      auth_mode: authMode,
      storage: supabase ? "supabase" : "memory",
      max_batch_size: config.queue.maxBatchSize,
      cdn_configured: cdn.configured,
      cdn_provider: cdn.name,
      image: {
        width: config.image.width,
        height: config.image.height,
        format: config.image.format,
        variants: config.image.variants,
      },
      publishing: "manual",
      date_format: config.date,
      show_publisher_logo: config.card.showPublisherLogo,
      browser_fallback_enabled: config.browser.enabled,
    },
  });

  const server = app.listen(config.port, () => {
    logger.info("News card API listening", {
      port: config.port,
      env: config.env,
      cdn: cdn.name,
      auth: authMode,
      storage: supabase ? "supabase" : "memory",
    });
  });

  try {
    const recovered = await service.recover();
    if (recovered)
      logger.info("Recovered unfinished jobs", { count: recovered });
  } catch (err) {
    logger.error(
      "Could not recover unfinished jobs (is the database migrated?)",
      { error: err },
    );
  }

  const shutdown = async (signal) => {
    logger.info("Shutting down", { signal });
    queue.stop();
    server.close();
    await Promise.allSettled([browser?.close(), closeSafeFetch()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
