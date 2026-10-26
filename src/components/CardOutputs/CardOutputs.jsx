import { CARD_VARIANTS, variantImageUrl } from "../../../shared/types.js";
import { useAppConfig } from "../../lib/config";
import { NewsCardPreview } from "../NewsCardPreview/NewsCardPreview";

/**
 * The three outputs of one article: the same metadata bound to the standard, feature and list
 * designs, each with its own image crop. The website gets the same HTML and CSS through the
 * public news API, so it renders exactly as in this preview.
 */
export function CardOutputs({ card, previewHeight = 500 }) {
  const config = useAppConfig();
  const options = {
    date: config.date_format,
    publisherLogo: config.show_publisher_logo,
  };

  return (
    <div className="outputsGrid">
      {CARD_VARIANTS.map(({ key, design, label }) => {
        const size = config.image.variants?.[key] ?? CARD_VARIANTS.find((v) => v.key === key);
        const ready = !!variantImageUrl(card, key);
        return (
          <figure key={key} className={`outputCard outputCard-${design}`}>
            <figcaption className="outputHeader">
              <strong>{label}</strong>
              <span className="muted small">
                {size.width}×{size.height}
                {!ready && " · image not generated yet"}
              </span>
            </figcaption>
            <NewsCardPreview
              card={card}
              variant={key}
              dateFormat={options.date}
              publisherLogo={options.publisherLogo}
              aspectRatio={`${size.width} / ${size.height}`}
              height={design === "list" ? Math.min(previewHeight, 280) : previewHeight}
            />
          </figure>
        );
      })}
    </div>
  );
}
