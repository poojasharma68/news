import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDevCdnAdapter } from "../server/services/cdnAdapter.js";

describe("local-dev CDN", () => {
  let dir;
  afterEach(() => dir && rm(dir, { recursive: true, force: true }));

  it("reads back its own files so uploaded originals can be re-cropped locally", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dev-cdn-"));
    const cdn = new LocalDevCdnAdapter(dir, "http://localhost:8787");
    const { url } = await cdn.upload({
      filename: "news-card-original-abc.jpg",
      buffer: Buffer.from([1, 2, 3]),
    });
    expect(url).toBe("http://localhost:8787/dev-cdn/news-card-original-abc.jpg");
    expect([...(await cdn.read(url))]).toEqual([1, 2, 3]);
  });

  it("reads nothing outside its folder or from other hosts", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dev-cdn-"));
    const cdn = new LocalDevCdnAdapter(dir, "http://localhost:8787");
    expect(await cdn.read("http://localhost:8787/dev-cdn/missing.jpg")).toBeNull();
    expect(await cdn.read("http://localhost:8787/dev-cdn/../package.json")).toBeNull();
    expect(await cdn.read("http://localhost:8787/dev-cdn/..%2Fpackage.json")).toBeNull();
    expect(await cdn.read("https://example.com/dev-cdn/a.jpg")).toBeNull();
    expect(await cdn.read(null)).toBeNull();
  });
});
