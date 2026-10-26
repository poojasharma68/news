import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatPublishDate,
  generateCardHtml,
  generateCardsHtml,
  generateExportHtml,
  safeHttpUrl,
} from "../shared/htmlGenerator.js";

const card = {
  title: "Masters’ Union & ET: a “very” long title that is stored in full",
  description: "Full description",
  publisher: "The Economic Times",
  published_at: "2026-10-10T04:00:00.000Z",
  cdn_image_url: "https://cdn.example.com/news-card-1.webp",
  source_url: "https://example.com/source",
  canonical_url: "https://example.com/canonical",
};

const EXPECTED = `<div class="newsCard">
    <img
        src="https://cdn.example.com/news-card-1.webp"
        alt="Masters’ Union &amp; ET: a “very” long title that is stored in full"
    >

    <div class="newsCardContent">
        <div class="upperContent">
            <p class="cardHeading">
                The Economic Times
            </p>

            <p class="publishDate">
                Oct 10, 2026
            </p>
        </div>

        <div class="middleBelowTxt">
            <p class="belowHeading">
                Masters’ Union &amp; ET: a “very” long title that is stored in full
            </p>

            <p class="cardSubText">
                Full description
            </p>
        </div>

        <div class="redirectDivi">
            <a
                class="btnBlack outline btnSm"
                target="_blank"
                rel="noopener noreferrer"
                href="https://example.com/canonical"
            >
                Read More
            </a>
        </div>
    </div>
</div>`;

describe("generateCardHtml", () => {
  it("reproduces the exact website structure and class names", () => {
    expect(generateCardHtml(card)).toBe(EXPECTED);
  });

  it("escapes text and attributes and blocks script URLs", () => {
    const html = generateCardHtml({
      ...card,
      title: '"><script>alert(1)</script>',
      publisher: "<img src=x onerror='x'>",
      cdn_image_url: "javascript:alert(1)",
      canonical_url: "javascript:alert(2)",
      source_url: "data:text/html,hi",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain('href="#"');
  });

  it("falls back to the source URL when there is no canonical URL", () => {
    expect(generateCardHtml({ ...card, canonical_url: null })).toContain(
      'href="https://example.com/source"',
    );
  });

  it("never truncates the stored text", () => {
    const long = "word ".repeat(200).trim();
    expect(generateCardHtml({ ...card, description: long })).toContain(long);
  });
});

describe("dates and URLs", () => {
  it("formats dates in the configured time zone", () => {
    // 20:00 UTC on Oct 9 is Oct 10 in India.
    expect(formatPublishDate("2026-10-09T20:00:00Z")).toBe("Oct 10, 2026");
    expect(
      formatPublishDate("2026-10-09T20:00:00Z", {
        timeZone: "UTC",
        month: "long",
      }),
    ).toBe("October 9, 2026");
    expect(formatPublishDate(null)).toBe("");
  });

  it("accepts only http(s) URLs", () => {
    expect(safeHttpUrl("https://a.com/x y")).toBe("https://a.com/x%20y");
    expect(safeHttpUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(escapeHtml(`<>&"'\``)).toBe("&lt;&gt;&amp;&quot;&#39;&#96;");
  });
});

describe("bulk export", () => {
  it("joins multiple cards and optionally wraps them in a document with clamp CSS", () => {
    expect(
      generateCardsHtml([card, card]).match(/class="newsCard"/g),
    ).toHaveLength(2);
    const doc = generateExportHtml([card], {
      includeStyles: true,
      format: "document",
    });
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc).toContain("-webkit-line-clamp: 2");
    expect(generateExportHtml([card], { format: "snippet" })).not.toContain(
      "<style>",
    );
  });
});

describe("card designs", () => {
  const logoCard = { ...card, cdn_publisher_logo_url: "https://cdn.example.com/logo.webp" };

  it("renders the feature card as one link with a date badge and the title", () => {
    const html = generateCardHtml(card, { variant: "medium" });
    expect(html.startsWith('<a class="newsCardFeature" href="https://example.com/canonical"')).toBe(true);
    expect(html).toContain("10 Oct 2026</span>");
    expect(html).toContain('<p class="featurePublisher">The Economic Times</p>');
    expect(html).toContain("Masters’ Union &amp; ET");
  });

  it("shows the logo instead of the publisher name on the feature card when enabled", () => {
    const html = generateCardHtml(logoCard, { variant: "medium", publisherLogo: true });
    expect(html).toContain('class="publisherLogo" src="https://cdn.example.com/logo.webp"');
    expect(html).not.toContain("featurePublisher");
  });

  it("renders the list card with a publisher pill, ordinal date and View Article link", () => {
    const html = generateCardHtml(card, { variant: "small" });
    expect(html).toContain('<p class="listPublisher">The Economic Times</p>');
    expect(html).toContain("10th October</p>");
    expect(html).toContain('href="https://example.com/canonical" target="_blank" rel="noopener noreferrer">View Article');
  });

  it("uses correct ordinals", () => {
    const day = (d) =>
      generateCardHtml({ ...card, published_at: `2026-10-${d}T06:00:00Z` }, { variant: "small" });
    expect(day("01")).toContain("1st October");
    expect(day("02")).toContain("2nd October");
    expect(day("03")).toContain("3rd October");
    expect(day("11")).toContain("11th October");
    expect(day("22")).toContain("22nd October");
  });

  it("puts the standard card logo in its own band above the content", () => {
    const html = generateCardHtml(logoCard, { publisherLogo: true });
    expect(html.indexOf("publisherLogoBand")).toBeGreaterThan(html.indexOf("<img"));
    expect(html.indexOf("publisherLogoBand")).toBeLessThan(html.indexOf("newsCardContent"));
  });

  it("escapes text in every design", () => {
    const evil = { ...card, title: "<script>x</script>", publisher: "<b>p</b>" };
    for (const variant of ["large", "medium", "small"]) {
      const html = generateCardHtml(evil, { variant });
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<b>");
    }
  });
});
