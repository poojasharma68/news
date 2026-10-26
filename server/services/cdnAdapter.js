/**
 * Adapter for the existing Masters' Union CDN service.
 *
 * The CDN's API is not documented in this repository, so no endpoint, field name or response
 * shape is assumed. The HTTP adapter is driven entirely by CDN_* environment variables
 * (see README → "CDN configuration"). Credentials stay on the server.
 *
 *   CDN_PROVIDER=http       → HttpCdnAdapter (your CDN: multipart, raw body, or JSON with an image URL)
 *   CDN_PROVIDER=local-dev  → LocalDevCdnAdapter (writes to disk; refused in production)
 *   CDN_PROVIDER=none       → uploads fail with CDN_NOT_CONFIGURED; extracted data is kept
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PipelineError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a value from a JSON response using a dot path such as "data.url" or "files.0.cdnUrl". */
export function getByPath(value, dotPath) {
  if (!dotPath || dotPath === "$body") return value;
  return dotPath.split(".").reduce((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return acc[key];
  }, value);
}

export function validateCdnUrl(value, options) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PipelineError(
      "CDN_INVALID_RESPONSE",
      "The CDN response did not contain an image URL at the configured CDN_RESPONSE_URL_PATH.",
    );
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PipelineError(
      "CDN_INVALID_RESPONSE",
      "The CDN returned an invalid URL.",
    );
  }
  if (
    url.protocol !== "https:" &&
    (options.requireHttps || url.protocol !== "http:")
  ) {
    throw new PipelineError(
      "CDN_INVALID_RESPONSE",
      "The CDN returned a non-HTTPS URL.",
    );
  }
  if (
    options.publicUrlPrefix &&
    !url.href.startsWith(options.publicUrlPrefix)
  ) {
    throw new PipelineError(
      "CDN_INVALID_RESPONSE",
      `The CDN URL does not start with the expected prefix (${options.publicUrlPrefix}).`,
    );
  }
  return url.href;
}

export class HttpCdnAdapter {
  name = "http";
  configured = true;

  constructor(cfg, requireHttps, fetchImpl = fetch) {
    this.cfg = cfg;
    this.requireHttps = requireHttps;
    this.fetchImpl = fetchImpl;
    if (!cfg.uploadUrl)
      throw new Error("CDN_UPLOAD_URL is required for the http CDN adapter.");
    this.inputMode = cfg.mode === "url-json" ? "url" : "file";
  }

  buildRequest(input) {
    const headers = { accept: "application/json, text/plain;q=0.9" };
    if (this.cfg.authHeaderValue)
      headers[this.cfg.authHeaderName] = this.cfg.authHeaderValue;

    if (this.cfg.mode === "multipart") {
      const form = new FormData();
      for (const [key, value] of Object.entries(this.cfg.extraFields))
        form.append(key, value);
      form.append(
        this.cfg.fileField,
        new Blob([input.buffer], { type: input.contentType }),
        input.filename,
      );
      return { body: form, headers };
    }
    if (this.cfg.mode === "raw") {
      headers["content-type"] = input.contentType;
      headers["x-file-name"] = input.filename;
      return { body: input.buffer, headers };
    }
    if (!input.sourceUrl)
      throw new PipelineError(
        "CDN_UPLOAD_FAILED",
        "The CDN is configured for URL ingestion but no source image URL is available.",
      );
    headers["content-type"] = "application/json";
    return {
      body: JSON.stringify({
        ...this.cfg.extraFields,
        [this.cfg.urlField]: input.sourceUrl,
        filename: input.filename,
      }),
      headers,
    };
  }

  async upload(input) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      try {
        const { body, headers } = this.buildRequest(input);
        const res = await this.fetchImpl(this.cfg.uploadUrl, {
          method: this.cfg.method,
          headers,
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          const retryable =
            res.status >= 500 || res.status === 429 || res.status === 408;
          lastError = new PipelineError(
            "CDN_UPLOAD_FAILED",
            `CDN upload failed with HTTP ${res.status}.`,
            { retryable, status: res.status },
          );
          logger.warn("CDN upload failed", {
            status: res.status,
            attempt,
            body: text.slice(0, 300),
          });
          if (!retryable) throw lastError;
          continue;
        }
        let payload = text.trim();
        if (
          (res.headers.get("content-type") ?? "").includes("json") ||
          /^[[{]/.test(text.trim())
        ) {
          try {
            payload = JSON.parse(text);
          } catch {
            throw new PipelineError(
              "CDN_INVALID_RESPONSE",
              "The CDN returned malformed JSON.",
            );
          }
        }
        const url = validateCdnUrl(
          getByPath(payload, this.cfg.responseUrlPath),
          {
            publicUrlPrefix: this.cfg.publicUrlPrefix,
            requireHttps: this.requireHttps,
          },
        );
        return { url, provider: this.name };
      } catch (err) {
        if (err instanceof PipelineError && !err.retryable) throw err;
        lastError =
          err instanceof PipelineError
            ? err
            : new PipelineError(
                "CDN_UPLOAD_FAILED",
                `CDN upload failed: ${err.message}`,
                { retryable: true, cause: err },
              );
      }
    }
    throw (
      lastError ??
      new PipelineError("CDN_UPLOAD_FAILED", "CDN upload failed.", {
        retryable: true,
      })
    );
  }
}

/** Development-only adapter that stores processed images on disk and serves them at /dev-cdn. */
export class LocalDevCdnAdapter {
  name = "local-dev";
  configured = true;
  inputMode = "file";

  constructor(directory, publicBaseUrl) {
    this.directory = directory;
    this.publicBaseUrl = publicBaseUrl;
  }

  async upload(input) {
    const safeName = path
      .basename(input.filename)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, safeName), input.buffer);
    return {
      url: `${this.publicBaseUrl}/dev-cdn/${safeName}`,
      provider: this.name,
    };
  }
}

export class UnconfiguredCdnAdapter {
  name = "none";
  configured = false;
  inputMode = "file";

  async upload() {
    throw new PipelineError(
      "CDN_NOT_CONFIGURED",
      "The CDN integration is not configured (set CDN_PROVIDER and CDN_* variables). Extracted data was saved; retry once the CDN is configured.",
    );
  }
}

export function createCdnAdapter(config) {
  switch (config.cdn.provider) {
    case "http":
      return new HttpCdnAdapter(config.cdn, config.isProduction);
    case "local-dev":
      if (config.isProduction)
        throw new Error(
          "The local-dev CDN adapter cannot be used in production.",
        );
      return new LocalDevCdnAdapter(
        path.resolve(config.cdn.localDir),
        config.cdn.publicBaseUrl,
      );
    default:
      return new UnconfiguredCdnAdapter();
  }
}
