import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { generateCardHtml } from "../shared/htmlGenerator.js";
import { processLogo } from "../server/services/imageProcessor.js";
import { parseMetadata } from "../server/services/metadataParser.js";

const PAGE_URL = "https://news.example.com/education/story-123";

const page = (head) =>
  `<!doctype html><html><head>${head}</head><body></body></html>`;

describe("publisher logo extraction", () => {
  it("prefers the JSON-LD publisher logo, following @id references", () => {
    const meta = parseMetadata(
      page(`
<link rel="apple-touch-icon" href="/touch.png">
<script type="application/ld+json">{"@graph":[
  {"@type":"NewsArticle","headline":"Story","publisher":{"@id":"#org"}},
  {"@type":"NewsMediaOrganization","@id":"#org","name":"Example News",
   "logo":{"@type":"ImageObject","url":"/brand/masthead.svg"}}
]}</script>`),
      PAGE_URL,
    );
    expect(meta.publisherLogoUrl).toBe(
      "https://news.example.com/brand/masthead.svg",
    );
    expect(meta.sources.publisherLogoUrl).toBe("json-ld:publisher.logo");
  });

  it("falls back to the largest touch icon, then the largest non-ICO favicon", () => {
    const touch = parseMetadata(
      page(`
<link rel="apple-touch-icon" sizes="120x120" href="/t120.png">
<link rel="apple-touch-icon" sizes="180x180" href="/t180.png">
<link rel="icon" href="/favicon.png">`),
      PAGE_URL,
    );
    expect(touch.publisherLogoUrl).toBe("https://news.example.com/t180.png");

    const icon = parseMetadata(
      page(`
<link rel="icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/f32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/f192.png">`),
      PAGE_URL,
    );
    expect(icon.publisherLogoUrl).toBe("https://news.example.com/f192.png");
  });

  it("returns null when only an ICO favicon exists", () => {
    const meta = parseMetadata(
      page(`<link rel="shortcut icon" href="/favicon.ico">`),
      PAGE_URL,
    );
    expect(meta.publisherLogoUrl).toBeNull();
  });
});

describe("processLogo", () => {
  it("rasterises SVG to a transparent WebP that fits the logo box", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><ellipse cx="300" cy="150" rx="200" ry="50" fill="#c00"/></svg>',
    );
    const out = await processLogo(svg);
    expect(out.format).toBe("webp");
    expect(out.height).toBeLessThanOrEqual(160);
    expect(out.width).toBeLessThanOrEqual(320);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.hasAlpha).toBe(true);
    // The transparent margin around the mark is trimmed: 400×100 ellipse scaled into 320×160.
    expect([out.width, out.height]).toEqual([320, 80]);
  });

  it("does not enlarge small logos and rejects tiny ones", async () => {
    const small = await sharp({
      create: { width: 48, height: 48, channels: 4, background: "#00f" },
    })
      .png()
      .toBuffer();
    const out = await processLogo(small);
    expect([out.width, out.height]).toEqual([48, 48]);

    const tiny = await sharp({
      create: { width: 8, height: 8, channels: 4, background: "#00f" },
    })
      .png()
      .toBuffer();
    await expect(processLogo(tiny)).rejects.toMatchObject({
      code: "IMAGE_TOO_SMALL",
    });
  });
});

describe("card HTML with a publisher logo", () => {
  const card = {
    title: "Title",
    description: "Description",
    publisher: "Example News",
    published_at: "2026-10-10T04:00:00.000Z",
    cdn_image_url: "https://cdn.example.com/card.webp",
    cdn_publisher_logo_url: "https://cdn.example.com/logo.webp",
    source_url: "https://example.com/a",
  };

  it("leaves the website markup unchanged unless the option is on", () => {
    expect(generateCardHtml(card)).not.toContain("publisherLogo");
  });

  it("adds the logo before the publisher name when enabled", () => {
    const html = generateCardHtml(card, { publisherLogo: true });
    expect(html).toContain(
      '<img class="publisherLogo" src="https://cdn.example.com/logo.webp" alt="" loading="lazy">',
    );
    expect(html.indexOf("publisherLogo")).toBeLessThan(
      html.indexOf("Example News"),
    );
    expect(
      generateCardHtml(
        { ...card, cdn_publisher_logo_url: "javascript:alert(1)" },
        { publisherLogo: true },
      ),
    ).not.toContain("publisherLogo");
  });
});
