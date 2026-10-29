import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  getByPath,
  HttpCdnAdapter,
  validateCdnUrl,
} from "../server/services/cdnAdapter.js";
import { detectContentBox, focusCrop, ImageService } from "../server/services/imageProcessor.js";
import { focusFor, mergeFocus, sameFocus } from "../shared/types.js";

const SPEC = {
  width: 800,
  height: 450,
  fit: "cover",
  position: "centre",
  format: "webp",
  quality: 80,
  background: "#ffffff",
  minSourceWidth: 200,
  minSourceHeight: 100,
};

const makeImage = (width, height, format = "png") =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  })
    [format]()
    .toBuffer();

function service(fetchResult) {
  const fetcher = vi.fn(async (url) => ({
    url,
    status: 200,
    headers: {},
    contentType: "image/png",
    body: Buffer.alloc(0),
    truncated: false,
    redirects: [],
    ...fetchResult,
  }));
  return {
    images: new ImageService(SPEC, fetcher, {
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      maxRedirects: 2,
      userAgent: "test",
    }),
    fetcher,
  };
}

describe("ImageService", () => {
  it("crops and resizes to the configured card size", async () => {
    const { images } = service();
    const out = await images.process(await makeImage(1600, 1200));
    const meta = await sharp(out.buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 800, 450]);
    expect(out.contentType).toBe("image/webp");
    expect(out.upscaled).toBe(false);
  });

  it("produces a stable cache key for identical input so uploads can be reused", async () => {
    const { images } = service();
    const buffer = await makeImage(1200, 700);
    const [a, b] = await Promise.all([
      images.process(buffer),
      images.process(Buffer.from(buffer)),
    ]);
    expect(a.cacheKey).toBe(b.cacheKey);
    const other = await images.process(await makeImage(1200, 701));
    expect(other.cacheKey).not.toBe(a.cacheKey);
  });

  it("flags upscaling of small sources", async () => {
    const { images } = service();
    expect((await images.process(await makeImage(400, 300))).upscaled).toBe(
      true,
    );
  });

  it("rejects invalid, unsupported and too-small images", async () => {
    const { images } = service();
    await expect(
      images.inspect(Buffer.from("not an image")),
    ).rejects.toMatchObject({ code: "IMAGE_INVALID" });
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"></svg>',
    );
    await expect(images.inspect(svg)).rejects.toMatchObject({
      code: "IMAGE_UNSUPPORTED",
    });
    await expect(
      images.inspect(await makeImage(120, 80)),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_SMALL" });
    await expect(
      images.inspect(await makeImage(900, 500, "jpeg")),
    ).resolves.toMatchObject({ format: "jpeg", width: 900 });
  });

  it("validates downloaded content type and status", async () => {
    const html = service({
      contentType: "text/html",
      body: Buffer.from("<html>"),
    });
    await expect(
      html.images.download("https://img.example.com/a.jpg"),
    ).rejects.toMatchObject({ code: "IMAGE_UNSUPPORTED" });
    const missing = service({ status: 404 });
    await expect(
      missing.images.download("https://img.example.com/a.jpg"),
    ).rejects.toMatchObject({
      code: "IMAGE_DOWNLOAD_FAILED",
      retryable: false,
    });
    const flaky = service({ status: 503 });
    await expect(
      flaky.images.download("https://img.example.com/a.jpg"),
    ).rejects.toMatchObject({ retryable: true });
    const ok = service({ body: await makeImage(900, 500) });
    await expect(
      ok.images.download("https://img.example.com/a.png"),
    ).resolves.toMatchObject({ info: { width: 900 } });
  });
});

describe("focal point crop", () => {
  // Left half red, right half blue.
  const halves = () =>
    sharp({ create: { width: 1600, height: 900, channels: 3, background: "#ff0000" } })
      .composite([
        {
          input: { create: { width: 800, height: 900, channels: 3, background: "#0000ff" } },
          left: 800,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
  const pixel = async (buffer, x, y) => {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const square = { ...SPEC, width: 400, height: 400, format: "png" };

  it("places the crop window like CSS object-position", () => {
    // 1600×900 into 400×400 scales to 711×400; 311px of width can move.
    expect(focusCrop(1600, 900, 400, 400, { x: 0, y: 0.5 })).toMatchObject({ left: 0, top: 0 });
    expect(focusCrop(1600, 900, 400, 400, { x: 1, y: 0.5 })).toMatchObject({ scaledWidth: 711, left: 311 });
    expect(focusCrop(1600, 900, 400, 400, { x: 0.5, y: 0.5 }).left).toBe(156);
  });

  it("fills the whole card and keeps the focal side in view", async () => {
    const svc = new ImageService(square);
    const left = await svc.process(await halves(), "h", square, { x: 0, y: 0.5 });
    const right = await svc.process(await halves(), "h", square, { x: 1, y: 0.5 });
    expect([left.width, left.height]).toEqual([400, 400]);
    expect((await pixel(left.buffer, 2, 200))[0]).toBeGreaterThan(200); // red edge kept
    expect((await pixel(right.buffer, 397, 200))[2]).toBeGreaterThan(200); // blue edge kept
    expect(right.cacheKey).toContain(":focus1.000,0.500");
    expect(left.cacheKey).not.toBe(right.cacheKey);
  });

  it("zooms in by shrinking the crop window, as in Figma's crop mode", () => {
    // 1600×900 into 400×400 at zoom 2 scales to 1422×800; the window is 400 of those pixels.
    expect(focusCrop(1600, 900, 400, 400, { x: 0.5, y: 0.5, zoom: 2 })).toMatchObject({
      scaledWidth: 1422,
      scaledHeight: 800,
      left: 511,
      top: 200,
    });
    expect(focusCrop(1600, 900, 400, 400, { x: 0, y: 1, zoom: 2 })).toMatchObject({ left: 0, top: 400 });
  });

  it("produces a zoomed crop with its own cache key", async () => {
    const svc = new ImageService(square);
    const out = await svc.process(await halves(), "h", square, { x: 0, y: 0.5, zoom: 2 });
    expect([out.width, out.height]).toEqual([400, 400]);
    expect(out.cacheKey).toContain(":focus0.000,0.500,z2.000");
  });

  it("fits the whole image and fills single-colour edges with that colour", async () => {
    // A white mark on black, like a logo: 1600×900 into 400×400 is 400×225 with 88px bands.
    const logo = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#000000" } })
      .composite([
        {
          input: { create: { width: 1200, height: 500, channels: 3, background: "#ffffff" } },
          left: 200,
          top: 200,
        },
      ])
      .png()
      .toBuffer();
    const svc = new ImageService(square);
    const out = await svc.process(logo, "logo", square, { x: 0.5, y: 0.5, fit: "contain" });
    expect([out.width, out.height]).toEqual([400, 400]);
    expect(await pixel(out.buffer, 200, 10)).toEqual([0, 0, 0]); // band: black, not white
    expect(await pixel(out.buffer, 200, 390)).toEqual([0, 0, 0]);
    // The mark is not cropped: its left and right ends (x 50–350) are still in the card.
    expect((await pixel(out.buffer, 55, 200))[0]).toBeGreaterThan(200);
    expect((await pixel(out.buffer, 345, 200))[0]).toBeGreaterThan(200);
    expect(out.cacheKey).toContain(":contain");
    expect(out.auto).toBeNull();
  });

  it("fills around a whole photo with mixed edges in one solid colour, never blurred", async () => {
    // Top and bottom rows are red on the left half and blue on the right: one colour is used.
    const svc = new ImageService(square);
    const out = await svc.process(await halves(), "h", square, { x: 0.5, y: 0.5, fit: "contain" });
    expect([out.width, out.height]).toEqual([400, 400]);
    expect((await pixel(out.buffer, 2, 200))[0]).toBeGreaterThan(200); // both ends of the photo kept
    expect((await pixel(out.buffer, 397, 200))[2]).toBeGreaterThan(200);
    const band = await pixel(out.buffer, 20, 10);
    expect(await pixel(out.buffer, 380, 10)).toEqual(band); // same colour across the band
    expect(await pixel(out.buffer, 380, 390)).toEqual(band);
    expect(out.edgeFill).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("uses the chosen background colour around the whole image", async () => {
    const svc = new ImageService(square);
    const out = await svc.process(await halves(), "h", square, {
      x: 0.5,
      y: 0.5,
      fit: "contain",
      fill: "#00ff00",
    });
    expect(await pixel(out.buffer, 200, 10)).toEqual([0, 255, 0]);
    expect(out.cacheKey).toContain(":contain#00ff00");
  });

  it("reports the edge colour of each card shape while the image is still cropped", async () => {
    const svc = new ImageService(square);
    const out = await svc.process(await halves(), "h", square, null);
    // 16:9 into a square leaves space above and below: the top/bottom rows' colour.
    expect(out.edgeFill).toMatch(/^#[0-9a-f]{6}$/);
    const wide = { ...square, width: 800, height: 200 };
    const beside = await svc.process(await halves(), "h", wide, null);
    // Space beside it: left (red) and right (blue) columns, whichever colour is most common.
    expect(["#ff0000", "#0000ff"]).toContain(beside.edgeFill);
  });

  it("stores the whole-image fit per card without a position or zoom", () => {
    expect(focusFor({ medium: { x: 0.1, y: 0.9, zoom: 3, fit: "contain" } }, "medium")).toEqual({
      x: 0.5,
      y: 0.5,
      fit: "contain",
    });
    expect(focusFor({ medium: { x: 0.5, y: 0.5, fit: "fill" } }, "medium")).toBeNull();
    expect(focusFor({ medium: { x: 0.5, y: 0.5, fit: "contain", fill: "#000000" } }, "medium")).toEqual({
      x: 0.5,
      y: 0.5,
      fit: "contain",
      fill: "#000000",
    });
    expect(focusFor({ medium: { x: 0.5, y: 0.5, fit: "contain", fill: "red" } }, "medium")).toBeNull();
    expect(focusFor({ medium: { x: 0.5, y: 0.5, fill: "#000000" } }, "medium")).toBeNull();
    expect(
      sameFocus(
        { medium: { x: 0.5, y: 0.5, fit: "contain", fill: "#000000" } },
        { medium: { x: 0.5, y: 0.5, fit: "contain" } },
      ),
    ).toBe(false);
    expect(sameFocus({ medium: { x: 0.5, y: 0.5, fit: "contain" } }, { medium: { x: 0.5, y: 0.5 } })).toBe(false);
    expect(mergeFocus({ large: { x: 0, y: 0 } }, { medium: { x: 0.5, y: 0.5, fit: "contain" } })).toEqual({
      large: { x: 0, y: 0 },
      medium: { x: 0.5, y: 0.5, fit: "contain" },
    });
  });

  it("stretches a free crop over the card's full width and height", async () => {
    // The left (red) half only, 800×900 of a 1600×900 photo, fills a 400×400 card edge to edge.
    const svc = new ImageService(square);
    const out = await svc.process(await halves(), "h", square, { x: 0, y: 0, w: 0.5, h: 1, fit: "crop" });
    expect([out.width, out.height]).toEqual([400, 400]);
    for (const [x, y] of [[2, 2], [397, 2], [2, 397], [397, 397]])
      expect((await pixel(out.buffer, x, y))[0]).toBeGreaterThan(200);
    expect((await pixel(out.buffer, 397, 200))[2]).toBeLessThan(60); // no blue: the right half is cut
    expect(out.cacheKey).toContain(":crop0.0000,0.0000,0.5000,1.0000");
    expect(out.auto).toBeNull();
  });

  it("stores a free crop per card and rejects one outside the image", () => {
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.3, fit: "crop" };
    expect(focusFor({ small: { ...crop, zoom: 2 } }, "small")).toBeNull();
    expect(focusFor({ small: crop }, "small")).toEqual(crop);
    expect(focusFor({ small: { ...crop, x: 0.6 } }, "small")).toBeNull();
    expect(focusFor({ small: { ...crop, w: 0.01 } }, "small")).toBeNull();
    expect(focusFor({ small: { x: 0.1, y: 0.2, fit: "crop" } }, "small")).toBeNull();
    expect(sameFocus({ small: crop }, { small: { ...crop, w: 0.4 } })).toBe(false);
    expect(mergeFocus(null, { small: crop })).toEqual({ small: crop });
  });

  it("keeps a zoom with the point and leaves it out at 1", () => {
    expect(focusFor({ large: { x: 0.2, y: 0.4, zoom: 2.5 } }, "large")).toEqual({ x: 0.2, y: 0.4, zoom: 2.5 });
    expect(focusFor({ large: { x: 0.2, y: 0.4, zoom: 1 } }, "large")).toEqual({ x: 0.2, y: 0.4 });
    expect(focusFor({ large: { x: 0.2, y: 0.4, zoom: 99 } }, "large")).toBeNull();
    expect(mergeFocus(null, { small: { x: 1, y: 0, zoom: 3 } })).toEqual({ small: { x: 1, y: 0, zoom: 3 } });
    expect(sameFocus({ large: { x: 0.5, y: 0.5, zoom: 2 } }, { large: { x: 0.5, y: 0.5 } })).toBe(false);
    expect(sameFocus({ large: { x: 0.5, y: 0.5, zoom: 1 } }, { large: { x: 0.5, y: 0.5 } })).toBe(true);
  });

  it("keeps a separate focus point per card", () => {
    const focus = { medium: { x: 0.2, y: 0.4 } };
    expect(focusFor(focus, "medium")).toEqual({ x: 0.2, y: 0.4 });
    expect(focusFor(focus, "large")).toBeNull();
    expect(focusFor({ x: 0.3, y: 0.3 }, "small")).toEqual({ x: 0.3, y: 0.3 }); // older records
    expect(mergeFocus(focus, { small: { x: 1, y: 1 } })).toEqual({
      medium: { x: 0.2, y: 0.4 },
      small: { x: 1, y: 1 },
    });
    expect(mergeFocus(focus, { medium: null })).toBeNull();
    expect(sameFocus({ large: { x: 0.5, y: 0.5 } }, { large: { x: 0.5, y: 0.5 } })).toBe(true);
    expect(sameFocus(focus, null)).toBe(false);
  });

  it("automatic crop: keeps a person in frame and reports the crop it chose", async () => {
    // A plain grey scene with a skin-toned "face" with some detail near the right edge.
    const face = await sharp({
      create: {
        width: 160,
        height: 200,
        channels: 3,
        background: { r: 214, g: 160, b: 128 },
        noise: { type: "gaussian", mean: 0, sigma: 8 },
      },
    })
      .png()
      .toBuffer();
    const scene = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: "#9a9a9a" },
    })
      .composite([{ input: face, left: 1300, top: 300 }])
      .png()
      .toBuffer();
    const smart = { ...square, position: "smart" };
    const out = await new ImageService(smart).process(scene, "s", smart);
    expect(out.auto.x).toBeGreaterThan(0.8);
    expect(out.auto.y).toBe(0.5);
    expect(out.cacheKey).toContain(":auto");
    // An editor's crop wins over the automatic one.
    const manual = await new ImageService(smart).process(scene, "s", smart, { x: 0, y: 0.5 });
    expect(manual.auto).toBeNull();
  });

  it("ignores invalid focal points", async () => {
    const svc = new ImageService(square);
    const out = await svc.process(await halves(), "h", square, { x: 3, y: "a" });
    expect(out.cacheKey).not.toContain("focus");
  });
});

describe("publisher padding", () => {
  // A detailed "photo" (noise), like a real photo has detail everywhere.
  const photo = (width, height) =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: "#808080",
        noise: { type: "gaussian", mean: 128, sigma: 60 },
      },
    })
      .png()
      .toBuffer();
  // What publishers do: the photo centred on a wide canvas filled with a blurred, enlarged copy.
  const padded = async ({ stripes = false } = {}) => {
    const inner = await photo(300, 300);
    const behind = await sharp(inner).resize(600, 300, { fit: "cover" }).blur(20).toBuffer();
    const layers = [{ input: inner, left: 150, top: 0 }];
    if (stripes) {
      const bar = await sharp({
        create: { width: 12, height: 300, channels: 3, background: "#000000" },
      })
        .png()
        .toBuffer();
      layers.push({ input: bar, left: 138, top: 0 }, { input: bar, left: 450, top: 0 });
    }
    return sharp(behind).composite(layers).png().toBuffer();
  };

  it("finds the photo inside blurred side panels, with or without dark stripes", async () => {
    for (const stripes of [false, true]) {
      const box = await detectContentBox(await padded({ stripes }));
      expect(box.top).toBe(0);
      expect(box.height).toBe(1);
      expect(box.left).toBeGreaterThanOrEqual(0.25);
      expect(box.left).toBeLessThan(0.28);
      expect(box.left + box.width).toBeLessThanOrEqual(0.75);
      expect(box.left + box.width).toBeGreaterThan(0.72);
    }
  });

  // A "photo" whose edge columns are plain (a wall, a bench), so detail is not found along most
  // of its edge; only the centred, smooth bands and the step into full detail give it away.
  const plainEdgedPhoto = async () =>
    sharp(await photo(300, 300))
      .composite([
        { input: { create: { width: 14, height: 300, channels: 3, background: "#e8e8e8" } }, left: 6, top: 0 },
        { input: { create: { width: 300, height: 90, channels: 3, background: "#c8a070" } }, left: 0, top: 210 },
      ])
      .png()
      .toBuffer();

  it("finds a photo with plain areas along its edge inside centred blurred panels", async () => {
    const inner = await plainEdgedPhoto();
    const behind = await sharp(inner).resize(600, 300, { fit: "cover" }).blur(30).toBuffer();
    const image = await sharp(behind).composite([{ input: inner, left: 150, top: 0 }]).png().toBuffer();
    const box = await detectContentBox(image);
    expect(box.left).toBeGreaterThanOrEqual(0.25);
    expect(box.left).toBeLessThan(0.28);
    expect(box.left + box.width).toBeGreaterThan(0.72);
    expect(box.left + box.width).toBeLessThanOrEqual(0.75);
  });

  it("finds the photo inside nested padding: black bars around blurred panels", async () => {
    const inner = await photo(300, 300);
    const behind = await sharp(inner).resize(600, 300, { fit: "cover" }).blur(20).toBuffer();
    const blurred = await sharp(behind).composite([{ input: inner, left: 150, top: 0 }]).png().toBuffer();
    const image = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "#000000" },
    })
      .composite([{ input: blurred, left: 0, top: 50 }])
      .png()
      .toBuffer();
    const box = await detectContentBox(image);
    expect(box.left).toBeGreaterThanOrEqual(0.25);
    expect(box.left + box.width).toBeLessThanOrEqual(0.75);
    expect(box.top).toBeGreaterThanOrEqual(0.125);
    expect(box.top + box.height).toBeLessThanOrEqual(0.875);
    expect(box.width).toBeGreaterThan(0.44);
    expect(box.height).toBeGreaterThan(0.7);
  });

  it("keeps a smooth sky above a skyline: a band on one side only is not padding", async () => {
    // Buildings of different heights under a sky that slowly changes colour.
    const heights = [300, 240, 330, 270, 210, 310, 250, 290];
    const city = await sharp(await photo(800, 450))
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="450">${heights
              .map((h, i) => `<rect x="${i * 100}" y="${450 - h}" width="100" height="${h}"/>`)
              .join("")}</svg>`,
          ),
          blend: "dest-in",
        },
      ])
      .png()
      .toBuffer();
    const sky = Buffer.from(
      '<svg width="800" height="450"><defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#4a7fc0"/><stop offset="1" stop-color="#b5d3f0"/></linearGradient></defs><rect width="800" height="450" fill="url(#g)"/></svg>',
    );
    const image = await sharp(sky).composite([{ input: city }]).png().toBuffer();
    expect(await detectContentBox(image)).toBeNull();
  });

  it("leaves ordinary photos and subjects on a plain backdrop alone", async () => {
    expect(await detectContentBox(await photo(800, 450))).toBeNull();
    // A detailed round subject on a plain studio backdrop: no straight edge, not centred bands.
    const subject = await sharp(await photo(220, 220))
      .composite([
        {
          input: Buffer.from(
            '<svg width="220" height="220"><circle cx="110" cy="110" r="110"/></svg>',
          ),
          blend: "dest-in",
        },
      ])
      .png()
      .toBuffer();
    const portrait = await sharp({
      create: { width: 800, height: 450, channels: 3, background: "#d0d0d0" },
    })
      .composite([{ input: subject, left: 420, top: 115 }])
      .png()
      .toBuffer();
    expect(await detectContentBox(portrait)).toBeNull();
  });

  it("crops the card from the photo only, so no blur is left at the sides", async () => {
    const svc = new ImageService(SPEC);
    const out = await svc.process(await padded(), "p", SPEC);
    expect(out.content).toMatchObject({ top: 0, height: 1 });
    expect(out.cacheKey).toContain(":content");
    // Columns at both edges are as detailed as the photo, not smooth like the blurred panels.
    const { data, info } = await sharp(out.buffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const detail = (x) => {
      let sum = 0;
      for (let y = 0; y + 1 < info.height; y++)
        sum += Math.abs(data[(y + 1) * info.width + x] - data[y * info.width + x]);
      return sum / (info.height - 1);
    };
    const middle = detail(info.width >> 1);
    expect(detail(1)).toBeGreaterThan(middle * 0.7);
    expect(detail(info.width - 2)).toBeGreaterThan(middle * 0.7);
  });
});

describe("CDN adapter", () => {
  const cdnConfig = {
    provider: "http",
    uploadUrl: "https://cdn-api.example.com/upload",
    method: "POST",
    mode: "multipart",
    fileField: "file",
    urlField: "url",
    extraFields: { folder: "news-cards" },
    authHeaderName: "Authorization",
    authHeaderValue: "Bearer secret",
    responseUrlPath: "data.url",
    publicUrlPrefix: "https://cdn.example.com/",
    timeoutMs: 5000,
    maxRetries: 2,
    filenamePrefix: "news-card",
    localDir: "x",
    publicBaseUrl: "http://localhost",
  };
  const input = {
    buffer: Buffer.from("img"),
    contentType: "image/webp",
    filename: "news-card-abc.webp",
    hash: "abc",
  };

  it("reads nested response paths", () => {
    expect(
      getByPath({ data: { files: [{ url: "u" }] } }, "data.files.0.url"),
    ).toBe("u");
    expect(getByPath("plain", "$body")).toBe("plain");
  });

  it("validates returned URLs", () => {
    expect(() =>
      validateCdnUrl("javascript:alert(1)", { requireHttps: true }),
    ).toThrow();
    expect(() =>
      validateCdnUrl("https://evil.com/x", {
        requireHttps: true,
        publicUrlPrefix: "https://cdn.example.com/",
      }),
    ).toThrow();
    expect(
      validateCdnUrl("https://cdn.example.com/x.webp", {
        requireHttps: true,
        publicUrlPrefix: "https://cdn.example.com/",
      }),
    ).toBe("https://cdn.example.com/x.webp");
  });

  it("uploads multipart with auth, and retries transient failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { url: "https://cdn.example.com/news-card-abc.webp" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const adapter = new HttpCdnAdapter(cdnConfig, true, fetchImpl);
    await expect(adapter.upload(input)).resolves.toEqual({
      url: "https://cdn.example.com/news-card-abc.webp",
      provider: "http",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.headers.Authorization).toBe("Bearer secret");
    const form = init.body;
    expect(form.get("folder")).toBe("news-cards");
    expect(form.get("file").name).toBe("news-card-abc.webp");
  });

  it("does not retry client errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("bad", { status: 400 }));
    const adapter = new HttpCdnAdapter(cdnConfig, true, fetchImpl);
    await expect(adapter.upload(input)).rejects.toMatchObject({
      code: "CDN_UPLOAD_FAILED",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
