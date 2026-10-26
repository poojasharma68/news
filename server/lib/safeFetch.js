/**
 * Outbound HTTP client for user-supplied URLs. Redirects are followed manually so every hop is
 * re-validated, sockets resolve DNS through guardedLookup, and response bodies are size-limited.
 * No cookies are stored or sent.
 */
import { Agent, fetch } from "undici";
import { PipelineError } from "./errors.js";
import { assertUrlAllowed, guardedLookup } from "./ssrf.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let agent = null;
function getAgent() {
  agent ??= new Agent({
    connect: { lookup: guardedLookup, timeout: 10_000 },
    keepAliveTimeout: 4_000,
  });
  return agent;
}

async function readLimited(body, maxBytes, truncate) {
  if (!body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (size + value.byteLength > maxBytes) {
        if (!truncate)
          throw new PipelineError(
            "TOO_LARGE",
            `Response is larger than the ${Math.round(maxBytes / 1024)} KB limit.`,
          );
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        await reader.cancel().catch(() => undefined);
        return { buffer: Buffer.concat(chunks), truncated: true };
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  return { buffer: Buffer.concat(chunks), truncated: false };
}

function mapNetworkError(err, timedOut, timeoutMs) {
  if (err instanceof PipelineError) return err;
  if (timedOut)
    return new PipelineError(
      "TIMEOUT",
      `The request timed out after ${Math.round(timeoutMs / 1000)} s.`,
      { retryable: true },
    );
  const cause = err?.cause;
  const code = cause?.code ?? err?.code;
  if (code === "ESSRFBLOCKED") {
    return new PipelineError(
      "URL_NOT_ALLOWED",
      "The host resolves to a private or reserved network address.",
    );
  }
  if (code === "ENOTFOUND")
    return new PipelineError(
      "DNS_NOT_FOUND",
      "The website domain could not be found.",
    );
  if (
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return new PipelineError(
      "NETWORK",
      `The website's TLS certificate is invalid (${code}).`,
    );
  }
  return new PipelineError(
    "NETWORK",
    `Network error${code ? ` (${code})` : ""}: ${cause?.message ?? err?.message ?? "unknown"}`,
    {
      retryable: true,
      cause: err,
    },
  );
}

export const safeFetch = async (rawUrl, options) => {
  let current = assertUrlAllowed(rawUrl);
  const redirects = [];
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current.href, {
        dispatcher: getAgent(),
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": options.userAgent,
          accept: options.accept,
          "accept-language": "en-IN,en;q=0.9",
        },
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location)
          throw new PipelineError(
            "HTTP_ERROR",
            `Redirect (HTTP ${res.status}) without a Location header.`,
          );
        if (hop >= options.maxRedirects)
          throw new PipelineError(
            "TOO_MANY_REDIRECTS",
            `More than ${options.maxRedirects} redirects.`,
          );
        redirects.push(current.href);
        current = assertUrlAllowed(new URL(location, current));
        continue;
      }

      const declared = Number(res.headers.get("content-length") ?? "");
      if (
        !options.truncateOversize &&
        Number.isFinite(declared) &&
        declared > options.maxBytes
      ) {
        await res.body?.cancel().catch(() => undefined);
        throw new PipelineError(
          "TOO_LARGE",
          `Response is larger than the ${Math.round(options.maxBytes / 1024)} KB limit.`,
        );
      }

      const { buffer, truncated } = await readLimited(
        res.body,
        options.maxBytes,
        Boolean(options.truncateOversize),
      );
      const headers = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        url: current.href,
        status: res.status,
        headers,
        contentType: (headers["content-type"] ?? "").toLowerCase(),
        body: buffer,
        truncated,
        redirects,
      };
    }
  } catch (err) {
    throw mapNetworkError(err, timedOut, options.timeoutMs);
  } finally {
    clearTimeout(timer);
  }
};

/** Decodes an HTML/XML body using the declared or sniffed charset, falling back to UTF-8. */
export function decodeBody(body, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 4096).toString("latin1");
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

export async function closeSafeFetch() {
  if (agent) {
    await agent.close().catch(() => undefined);
    agent = null;
  }
}
