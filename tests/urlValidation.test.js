import { describe, expect, it } from "vitest";
import {
  checkArticleUrl,
  normalizeUrlKey,
  parseUrlList,
  uniqueValidUrls,
} from "../shared/urlUtils.js";
import {
  assertUrlAllowed,
  guardedLookup,
  isBlockedIp,
} from "../server/lib/ssrf.js";
import { PipelineError } from "../server/lib/errors.js";

describe("parseUrlList", () => {
  it("parses newline, tab and spreadsheet-style input and flags invalid / duplicate entries", () => {
    const text = [
      "https://education.economictimes.indiatimes.com/news/example-article-1",
      '"https://www.example-news-site.com/article-2"\thttps://www.example-publication.com/article-3',
      "",
      "not a url",
      "https://example-news-site.com/article-2/?utm_source=x#top",
      "javascript:alert(1)",
    ].join("\r\n");
    const entries = parseUrlList(text);
    expect(entries.map((e) => e.raw)).toHaveLength(8); // "not a url" splits into 3 tokens
    expect(uniqueValidUrls(entries)).toEqual([
      "https://education.economictimes.indiatimes.com/news/example-article-1",
      "https://www.example-news-site.com/article-2",
      "https://www.example-publication.com/article-3",
    ]);
    const dup = entries.find((e) => e.raw.includes("utm_source"));
    expect(dup?.duplicateOf).toBe(2);
    expect(entries.find((e) => e.raw.startsWith("javascript"))?.error).toMatch(
      /http/,
    );
  });

  it("accepts links copied without a scheme", () => {
    const check = checkArticleUrl("www.example.com/news/story");
    expect(check.ok && check.url.href).toBe(
      "https://www.example.com/news/story",
    );
  });

  it("rejects credentials, odd ports and single-label hosts", () => {
    expect(checkArticleUrl("https://user:pw@example.com/a").ok).toBe(false);
    expect(checkArticleUrl("https://example.com:8080/a").ok).toBe(false);
    expect(checkArticleUrl("http://intranet/a").ok).toBe(false);
  });
});

describe("normalizeUrlKey", () => {
  it("ignores scheme, www, fragments, tracking params, trailing slash and param order", () => {
    const a = normalizeUrlKey(
      "https://www.Example.com/news/a/?b=2&a=1&utm_medium=x&fbclid=y#frag",
    );
    const b = normalizeUrlKey("http://example.com/news/a?a=1&b=2");
    expect(a).toBe(b);
    expect(a).toBe("example.com/news/a?a=1&b=2");
  });
});

describe("SSRF protection", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.5",
    "64:ff9b::a9fe:a9fe",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each([
    "8.8.8.8",
    "151.101.1.69",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows public %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  it.each([
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/",
    "https://printer.local/",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "https://example.com:22/",
    "https://user:pass@example.com/",
  ])("rejects %s", (url) => {
    expect(() => assertUrlAllowed(url)).toThrow(PipelineError);
  });

  it("allows ordinary public article URLs", () => {
    expect(assertUrlAllowed("https://www.example.com/news/1").hostname).toBe(
      "www.example.com",
    );
  });

  it("refuses to connect when DNS resolves to a private address", async () => {
    const error = await new Promise((resolve) =>
      guardedLookup("localhost", {}, (err) => resolve(err)),
    );
    expect(error?.code).toBe("ESSRFBLOCKED");
  });
});
