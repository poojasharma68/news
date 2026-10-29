import { describe, expect, it } from "vitest";
import {
  buildBookmarklet,
  IMPORT_MESSAGE_TYPE,
  pageImportImage,
  pageImportLogo,
  parsePageImport,
  sameSite,
} from "../src/lib/pageImport.js";

const SOURCE =
  "https://educationworld.in/masters-union-reports-inr-33-39-lpa-average-for-2025-cohort/";

const message = (data, page = SOURCE) => ({
  type: IMPORT_MESSAGE_TYPE,
  v: 1,
  page,
  data,
});

describe("page import", () => {
  it("builds a bookmarklet that targets the dashboard origin and parses as JavaScript", () => {
    const href = buildBookmarklet("http://localhost:5173");
    expect(href.startsWith("javascript:")).toBe(true);
    const source = decodeURIComponent(href.slice("javascript:".length));
    expect(source).toContain('"http://localhost:5173"');
    expect(() => new Function(source)).not.toThrow();
  });

  it("matches the same site across www and subdomains only", () => {
    expect(sameSite("https://www.educationworld.in", SOURCE)).toBe(true);
    expect(sameSite("https://m.educationworld.in/x", SOURCE)).toBe(true);
    expect(sameSite("https://educationworld.in.evil.com", SOURCE)).toBe(false);
    expect(sameSite("not a url", SOURCE)).toBe(false);
  });

  it("cleans and returns the article fields", () => {
    const fields = parsePageImport(
      message({
        title: "  Masters' Union reports\n INR 33.39 LPA  ",
        description: "Average for the 2025 cohort.",
        publisher: "EducationWorld",
        published_at: "2026-10-20T09:30:00+05:30",
        image: "https://educationworld.in/wp-content/uploads/photo.jpg",
        logo: "https://cdn.educationworld.in/logo.svg",
        url: "https://www.educationworld.in/masters-union-reports/",
      }),
      SOURCE,
    );
    expect(fields).toEqual({
      title: "Masters' Union reports INR 33.39 LPA",
      description: "Average for the 2025 cohort.",
      publisher: "EducationWorld",
      published_at: "2026-10-20T04:00:00.000Z",
      original_image_url:
        "https://educationworld.in/wp-content/uploads/photo.jpg",
      publisher_logo_url: "https://cdn.educationworld.in/logo.svg",
      article_url: "https://www.educationworld.in/masters-union-reports/",
    });
  });

  it("drops unsafe URLs and invalid dates", () => {
    const fields = parsePageImport(
      message({
        title: "Title",
        image: "javascript:alert(1)",
        url: "https://other-site.com/story",
        published_at: "yesterday-ish",
      }),
      SOURCE,
    );
    expect(fields.original_image_url).toBe("");
    expect(fields.article_url).toBe("");
    expect(fields.published_at).toBe("");
  });

  it("turns an image downloaded by the bookmark into an upload file", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const file = pageImportImage({ imageBlob: blob });
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("article-image.jpg");
    expect(file.type).toBe("image/jpeg");

    expect(pageImportImage({})).toBeNull();
    expect(
      pageImportImage({ imageBlob: new Blob(["<svg/>"], { type: "image/svg+xml" }) }),
    ).toBeNull();
    expect(
      pageImportImage({ imageBlob: new Blob([], { type: "image/png" }) }),
    ).toBeNull();
    expect(pageImportImage({ imageBlob: "data:image/png;base64,AAAA" })).toBeNull();
  });

  it("accepts the image as a data URL from the clipboard route", async () => {
    const file = pageImportImage({
      imageData: `data:image/webp;base64,${Buffer.from([7, 8, 9]).toString("base64")}`,
    });
    expect(file.name).toBe("article-image.webp");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([7, 8, 9]);
    expect(pageImportImage({ imageData: "data:text/html;base64,PGh0bWw+" })).toBeNull();
    expect(pageImportImage({ imageData: "https://x.com/a.jpg" })).toBeNull();
  });

  it("rejects data from another site, foreign messages and empty pages", () => {
    expect(() =>
      parsePageImport(message({ title: "x" }, "https://example.com/a"), SOURCE),
    ).toThrow(/example\.com/);
    expect(() => parsePageImport({ type: "other" }, SOURCE)).toThrow(
      /not page data/,
    );
    expect(() =>
      parsePageImport(message({ title: "  ", image: "" }), SOURCE),
    ).toThrow(/No article details/);
  });

  it("turns a logo downloaded by the bookmark into an upload file, SVG included", () => {
    const svg = pageImportLogo({
      logoBlob: new Blob(["<svg/>"], { type: "image/svg+xml" }),
    });
    expect(svg.name).toBe("publisher-logo.svg");
    expect(svg.type).toBe("image/svg+xml");
    const png = pageImportLogo({
      logoData: `data:image/png;base64,${Buffer.from([1, 2]).toString("base64")}`,
    });
    expect(png.name).toBe("publisher-logo.png");
    expect(
      pageImportLogo({
        logoBlob: new Blob([new Uint8Array(3 * 1024 * 1024)], { type: "image/png" }),
      }),
    ).toBeNull();
    // SVG is accepted for logos only, not as the article image.
    expect(
      pageImportImage({ imageBlob: new Blob(["<svg/>"], { type: "image/svg+xml" }) }),
    ).toBeNull();
  });

  it("bookmarklet sends the logo and downloads cross-site files without cookies", async () => {
    const source = decodeURIComponent(
      buildBookmarklet("http://localhost:5173").slice("javascript:".length),
    );
    const meta = {
      'meta[property="og:title"]': { content: "Story" },
      'meta[property="og:image"]': { content: "https://img.cdn.com/photo.jpg" },
    };
    const el = (attrs) => ({ getAttribute: (n) => attrs[n] ?? null });
    const ldJson = JSON.stringify({
      "@graph": [
        { "@type": "NewsArticle", headline: "Story", publisher: { "@id": "#org" } },
        { "@type": "NewsMediaOrganization", "@id": "#org", logo: { url: "/logo.png" } },
      ],
    });
    const document = {
      title: "Story",
      querySelector: (sel) => (meta[sel] ? el(meta[sel]) : null),
      querySelectorAll: (sel) =>
        sel.includes("ld+json") ? [{ textContent: ldJson }] : [],
    };
    const fetchCalls = [];
    const fetch = async (url, opts) => {
      fetchCalls.push([url, opts.credentials]);
      return { ok: true, blob: async () => new Blob([new Uint8Array([1])], { type: "image/png" }) };
    };
    const posted = [];
    const window = { opener: { postMessage: (m, origin) => posted.push([m, origin]) } };
    let done;
    const finished = new Promise((r) => (done = r));
    const run = new Function(
      "document", "location", "fetch", "window", "navigator", "alert", "prompt", "FileReader",
      source,
    );
    class FakeReader {
      readAsDataURL() {
        this.result = "data:image/png;base64,AQ==";
        this.onload();
      }
    }
    run(
      document,
      { href: "https://news.example.com/story", origin: "https://news.example.com" },
      fetch,
      window,
      { clipboard: { writeText: async () => {} } },
      () => done(),
      () => done(),
      FakeReader,
    );
    await finished;
    expect(fetchCalls).toEqual([
      ["https://img.cdn.com/photo.jpg", "omit"],
      ["https://news.example.com/logo.png", "include"],
    ]);
    const [msg, origin] = posted[0];
    expect(origin).toBe("http://localhost:5173");
    expect(msg.v).toBe(2);
    expect(msg.data.logo).toBe("https://news.example.com/logo.png");
    expect(msg.imageBlob).toBeInstanceOf(Blob);
    expect(msg.logoBlob).toBeInstanceOf(Blob);
  });
});
