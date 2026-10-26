import { useMemo } from "react";
import { generateCardHtml } from "../../../shared/htmlGenerator.js";
import { CARD_CSS } from "../../../shared/newsCardStyles.js";

const PLACEHOLDER_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="#eceef1"/><text x="400" y="232" font-family="sans-serif" font-size="26" fill="#8a9099" text-anchor="middle">No CDN image yet</text></svg>',
)}`;

/**
 * Renders the exact card HTML and CSS produced for export inside a sandboxed iframe (no scripts),
 * so dashboard styles cannot leak into the preview and what editors review is what goes live.
 */
export function NewsCardPreview({
  card,
  variant,
  dateFormat,
  publisherLogo = false,
  aspectRatio = "16 / 9",
  height = 540,
}) {
  const srcDoc = useMemo(() => {
    const html = generateCardHtml(card, {
      date: dateFormat,
      imagePlaceholder: PLACEHOLDER_IMAGE,
      publisherLogo,
      variant,
    });
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>:root{--news-card-image-ratio:${aspectRatio};}*{box-sizing:border-box}html,body{margin:0}body{padding:12px;background:#f4f4f5}.newsCard,.newsCardFeature,.newsCardList{margin:0 auto}${CARD_CSS}</style></head><body>${html}</body></html>`;
  }, [card, variant, dateFormat, publisherLogo, aspectRatio]);

  return (
    <iframe
      className="previewFrame"
      title={`News card preview${variant ? ` (${variant})` : ""}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}
