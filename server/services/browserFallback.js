/**
 * Playwright rendering for publicly accessible pages that need JavaScript to expose metadata.
 * It does not attempt to solve CAPTCHAs or evade bot protection: the rendered HTML is passed
 * through the same challenge detector, and blocked pages go to manual verification.
 * Each render uses a fresh browser context, so no cookies or sessions are persisted.
 */
import { PipelineError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { assertHostResolvesPublic, assertUrlAllowed } from "../lib/ssrf.js";

const UNAVAILABLE_COOLDOWN_MS = 10 * 60 * 1000;

export class BrowserRenderer {
  browser = null;
  unavailableUntil = 0;
  unavailableReason = "";
  active = 0;
  waiters = [];

  constructor(options) {
    this.options = options;
  }

  async getBrowser() {
    if (Date.now() < this.unavailableUntil) {
      throw new PipelineError("BROWSER_UNAVAILABLE", this.unavailableReason);
    }
    if (!this.browser) {
      this.browser = (async () => {
        let playwright;
        try {
          playwright = await import("playwright");
        } catch {
          throw new PipelineError(
            "BROWSER_UNAVAILABLE",
            "Playwright is not installed.",
          );
        }
        try {
          return await playwright.chromium.launch({
            headless: true,
            args: ["--disable-dev-shm-usage"],
          });
        } catch {
          throw new PipelineError(
            "BROWSER_UNAVAILABLE",
            'Chromium could not be launched. Run "npm run playwright:install".',
          );
        }
      })();
      this.browser.catch((err) => {
        this.browser = null;
        this.unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
        this.unavailableReason = err.message;
        logger.warn("Browser fallback unavailable", { reason: err.message });
      });
    }
    return this.browser;
  }

  async acquire() {
    if (this.active < this.options.maxPages) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    this.waiters.shift()?.();
  }

  async render(rawUrl) {
    const url = assertUrlAllowed(rawUrl);
    await this.acquire();
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({
        userAgent: this.options.userAgent,
        javaScriptEnabled: true,
        acceptDownloads: false,
        serviceWorkers: "block",
        bypassCSP: false,
      });
      const hostChecks = new Map();
      try {
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (["image", "media", "font"].includes(request.resourceType()))
            return route.abort();
          try {
            const target = assertUrlAllowed(request.url());
            let check = hostChecks.get(target.hostname);
            if (!check) {
              check = assertHostResolvesPublic(target.hostname);
              hostChecks.set(target.hostname, check);
            }
            await check;
            return route.continue();
          } catch {
            return route.abort("blockedbyclient");
          }
        });

        const page = await context.newPage();
        const response = await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: this.options.timeoutMs,
        });
        await page
          .waitForLoadState("networkidle", { timeout: 5000 })
          .catch(() => undefined);
        const finalUrl = assertUrlAllowed(page.url()).href;
        return {
          html: await page.content(),
          finalUrl,
          status: response?.status() ?? 0,
          headers: response ? await response.allHeaders() : {},
        };
      } catch (err) {
        if (err instanceof PipelineError) throw err;
        const message =
          err instanceof Error ? err.message.split("\n")[0] : String(err);
        throw new PipelineError(
          "BROWSER_FAILED",
          `Browser rendering failed: ${message}`,
        );
      } finally {
        await context.close().catch(() => undefined);
      }
    } finally {
      this.release();
    }
  }

  async close() {
    const pending = this.browser;
    this.browser = null;
    if (pending)
      await (await pending.catch(() => null))?.close().catch(() => undefined);
  }
}
