import "dotenv/config";
import { z } from "zod";
import { CARD_VARIANTS } from "../shared/types.js";

const VARIANT_DEFAULTS = Object.fromEntries(CARD_VARIANTS.map((v) => [v.key, v]));

const emptyToUndefined = (value) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const int = (fallback, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(min).max(max).default(fallback),
  );

const bool = (fallback) =>
  z
    .preprocess(emptyToUndefined, z.string().optional())
    .transform((value) =>
      value === undefined
        ? fallback
        : ["true", "1", "yes", "on"].includes(value.toLowerCase()),
    );

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "production", "test"]).default("development"),
  ),
  PORT: int(8787, 1, 65535),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["debug", "info", "warn", "error"]).default("info"),
  ),
  CORS_ORIGIN: optionalString,
  SERVE_CLIENT: bool(false),
  TRUST_PROXY: z.preprocess(emptyToUndefined, z.string().default("loopback")),

  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  AUTH_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(["supabase", "none"]).default("supabase"),
  ),
  ADMIN_EMAILS: z.preprocess(emptyToUndefined, z.string().default("")),

  MAX_BATCH_SIZE: int(20, 1, 100),
  QUEUE_CONCURRENCY: int(3, 1, 10),
  JOB_MAX_RETRIES: int(2, 0, 5),
  RETRY_BASE_DELAY_MS: int(3000, 0, 120_000),

  FETCH_TIMEOUT_MS: int(15_000, 1000, 120_000),
  MAX_HTML_BYTES: int(3 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
  MAX_IMAGE_BYTES: int(10 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024),
  MAX_REDIRECTS: int(5, 0, 10),
  PUBLISHER_MIN_INTERVAL_MS: int(2000, 0, 60_000),
  BLOCKED_HOST_TTL_MS: int(30 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  USER_AGENT: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default(
        "Mozilla/5.0 (compatible; MUNewsCardBot/1.0; +https://mastersunion.org)",
      ),
  ),

  BROWSER_FALLBACK_ENABLED: bool(true),
  BROWSER_TIMEOUT_MS: int(25_000, 5000, 120_000),
  BROWSER_MAX_PAGES: int(2, 1, 5),
  RSS_FALLBACK_ENABLED: bool(true),

  // Large card image (the original card size); medium/small are the other two placements.
  CARD_IMAGE_WIDTH: int(VARIANT_DEFAULTS.large.width, 50, 4000),
  CARD_IMAGE_HEIGHT: int(VARIANT_DEFAULTS.large.height, 50, 4000),
  CARD_IMAGE_MEDIUM_WIDTH: int(VARIANT_DEFAULTS.medium.width, 50, 4000),
  CARD_IMAGE_MEDIUM_HEIGHT: int(VARIANT_DEFAULTS.medium.height, 50, 4000),
  CARD_IMAGE_SMALL_WIDTH: int(VARIANT_DEFAULTS.small.width, 50, 4000),
  CARD_IMAGE_SMALL_HEIGHT: int(VARIANT_DEFAULTS.small.height, 50, 4000),
  CARD_IMAGE_FIT: z.preprocess(
    emptyToUndefined,
    z.enum(["cover", "contain"]).default("cover"),
  ),
  CARD_IMAGE_POSITION: z.preprocess(
    emptyToUndefined,
    z
      .enum([
        "centre",
        "top",
        "bottom",
        "left",
        "right",
        "smart",
        "attention",
        "entropy",
      ])
      .default("smart"),
  ),
  CARD_IMAGE_FORMAT: z.preprocess(
    emptyToUndefined,
    z.enum(["webp", "jpeg", "png", "avif"]).default("webp"),
  ),
  CARD_IMAGE_QUALITY: int(82, 30, 100),
  CARD_IMAGE_BACKGROUND: z.preprocess(
    emptyToUndefined,
    z.string().default("#ffffff"),
  ),
  MIN_SOURCE_IMAGE_WIDTH: int(200, 1, 4000),
  MIN_SOURCE_IMAGE_HEIGHT: int(100, 1, 4000),

  CARD_SHOW_PUBLISHER_LOGO: bool(false),

  CARD_DATE_LOCALE: z.preprocess(emptyToUndefined, z.string().default("en-US")),
  CARD_DATE_MONTH: z.preprocess(
    emptyToUndefined,
    z.enum(["short", "long"]).default("short"),
  ),
  CARD_DATE_TIMEZONE: z.preprocess(
    emptyToUndefined,
    z.string().default("Asia/Kolkata"),
  ),

  CDN_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(["http", "unionstack", "local-dev", "none"]).default("none"),
  ),
  CDN_UPLOAD_URL: optionalString,
  UNIONSTACK_API_KEY: optionalString,
  UNIONSTACK_API_DOMAIN: optionalString,
  CDN_HTTP_METHOD: z.preprocess(
    emptyToUndefined,
    z.enum(["POST", "PUT"]).default("POST"),
  ),
  CDN_UPLOAD_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(["multipart", "raw", "url-json"]).default("multipart"),
  ),
  CDN_FILE_FIELD: z.preprocess(emptyToUndefined, z.string().default("file")),
  CDN_URL_FIELD: z.preprocess(emptyToUndefined, z.string().default("url")),
  CDN_EXTRA_FIELDS: optionalString,
  CDN_AUTH_HEADER_NAME: z.preprocess(
    emptyToUndefined,
    z.string().default("Authorization"),
  ),
  CDN_AUTH_HEADER_VALUE: optionalString,
  CDN_RESPONSE_URL_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("url"),
  ),
  CDN_PUBLIC_URL_PREFIX: optionalString,
  CDN_TIMEOUT_MS: int(30_000, 1000, 180_000),
  CDN_MAX_RETRIES: int(2, 0, 5),
  CDN_FILENAME_PREFIX: z.preprocess(
    emptyToUndefined,
    z.string().default("news-card"),
  ),

  LOCAL_CDN_DIR: z.preprocess(
    emptyToUndefined,
    z.string().default("dev-cdn-uploads"),
  ),
  PUBLIC_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().default("http://localhost:8787"),
  ),
});

function parseExtraFields(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'CDN_EXTRA_FIELDS must be a JSON object, e.g. {"folder":"news-cards"}',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CDN_EXTRA_FIELDS must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [k, String(v)]),
  );
}

export function loadConfig(source = process.env) {
  // On Render, default the public URL to the service's own address instead of localhost.
  const result = envSchema.safeParse({
    ...source,
    PUBLIC_BASE_URL: source.PUBLIC_BASE_URL || source.RENDER_EXTERNAL_URL,
  });
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = result.data;
  const isProduction = env.NODE_ENV === "production";

  if (isProduction && env.AUTH_MODE === "none") {
    throw new Error(
      "AUTH_MODE=none is not allowed in production. Configure Supabase Auth and ADMIN_EMAILS.",
    );
  }
  if (isProduction && env.CDN_PROVIDER === "local-dev") {
    throw new Error(
      "CDN_PROVIDER=local-dev is for local development only. Configure your CDN (CDN_PROVIDER=http).",
    );
  }
  if (env.CDN_PROVIDER === "http" && !env.CDN_UPLOAD_URL) {
    throw new Error("CDN_PROVIDER=http requires CDN_UPLOAD_URL.");
  }
  if (env.CDN_PROVIDER === "unionstack" && !env.UNIONSTACK_API_KEY) {
    throw new Error("CDN_PROVIDER=unionstack requires UNIONSTACK_API_KEY.");
  }

  return {
    env: env.NODE_ENV,
    isProduction,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: (env.CORS_ORIGIN ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    serveClient: env.SERVE_CLIENT,
    trustProxy: env.TRUST_PROXY,
    supabase: {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    },
    auth: {
      mode: env.AUTH_MODE,
      adminEmails: env.ADMIN_EMAILS.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    },
    queue: {
      maxBatchSize: env.MAX_BATCH_SIZE,
      concurrency: env.QUEUE_CONCURRENCY,
      maxRetries: env.JOB_MAX_RETRIES,
      retryBaseDelayMs: env.RETRY_BASE_DELAY_MS,
    },
    fetch: {
      timeoutMs: env.FETCH_TIMEOUT_MS,
      maxHtmlBytes: env.MAX_HTML_BYTES,
      maxImageBytes: env.MAX_IMAGE_BYTES,
      maxRedirects: env.MAX_REDIRECTS,
      userAgent: env.USER_AGENT,
      publisherMinIntervalMs: env.PUBLISHER_MIN_INTERVAL_MS,
      blockedHostTtlMs: env.BLOCKED_HOST_TTL_MS,
    },
    browser: {
      enabled: env.BROWSER_FALLBACK_ENABLED,
      timeoutMs: env.BROWSER_TIMEOUT_MS,
      maxPages: env.BROWSER_MAX_PAGES,
    },
    rssFallbackEnabled: env.RSS_FALLBACK_ENABLED,
    image: {
      width: env.CARD_IMAGE_WIDTH,
      height: env.CARD_IMAGE_HEIGHT,
      variants: {
        large: { width: env.CARD_IMAGE_WIDTH, height: env.CARD_IMAGE_HEIGHT },
        medium: {
          width: env.CARD_IMAGE_MEDIUM_WIDTH,
          height: env.CARD_IMAGE_MEDIUM_HEIGHT,
        },
        small: {
          width: env.CARD_IMAGE_SMALL_WIDTH,
          height: env.CARD_IMAGE_SMALL_HEIGHT,
        },
      },
      fit: env.CARD_IMAGE_FIT,
      position: env.CARD_IMAGE_POSITION,
      format: env.CARD_IMAGE_FORMAT,
      quality: env.CARD_IMAGE_QUALITY,
      background: env.CARD_IMAGE_BACKGROUND,
      minSourceWidth: env.MIN_SOURCE_IMAGE_WIDTH,
      minSourceHeight: env.MIN_SOURCE_IMAGE_HEIGHT,
    },
    card: {
      showPublisherLogo: env.CARD_SHOW_PUBLISHER_LOGO,
    },
    date: {
      locale: env.CARD_DATE_LOCALE,
      month: env.CARD_DATE_MONTH,
      timeZone: env.CARD_DATE_TIMEZONE,
    },
    cdn: {
      provider: env.CDN_PROVIDER,
      uploadUrl: env.CDN_UPLOAD_URL,
      method: env.CDN_HTTP_METHOD,
      mode: env.CDN_UPLOAD_MODE,
      fileField: env.CDN_FILE_FIELD,
      urlField: env.CDN_URL_FIELD,
      extraFields: parseExtraFields(env.CDN_EXTRA_FIELDS),
      authHeaderName: env.CDN_AUTH_HEADER_NAME,
      authHeaderValue: env.CDN_AUTH_HEADER_VALUE,
      responseUrlPath: env.CDN_RESPONSE_URL_PATH,
      publicUrlPrefix: env.CDN_PUBLIC_URL_PREFIX,
      timeoutMs: env.CDN_TIMEOUT_MS,
      maxRetries: env.CDN_MAX_RETRIES,
      filenamePrefix: env.CDN_FILENAME_PREFIX,
      unionstackApiKey: env.UNIONSTACK_API_KEY,
      unionstackApiDomain: env.UNIONSTACK_API_DOMAIN,
      localDir: env.LOCAL_CDN_DIR,
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    },
  };
}
