import { CARD_VARIANTS, variantImageUrl } from "../../../shared/types.js";
import { useAppConfig } from "../../lib/config";
import { isLocalImageUrl } from "../../lib/localImages";
import { copyToClipboard } from "../../lib/hooks";
import { NewsCardPreview } from "../NewsCardPreview/NewsCardPreview";
import { useToast } from "../Toast";

/** One image URL (CDN, or stored locally until Convert to CDN) with an open link and a copy button. */
function CdnLink({ label, url }) {
  const toast = useToast();
  const config = useAppConfig();
  const local = isLocalImageUrl(url, config.cdn_provider);
  return (
    <div className="cdnLink">
      <span className="muted small">
        {label}
        {url && !url.startsWith("data:") && (
          <span className={`storageTag ${local ? "isLocal" : "isCdn"}`}>{local ? "Local" : "CDN"}</span>
        )}
      </span>
      {url?.startsWith("data:") ? (
        <span className="muted small">cropped preview · local, not on the CDN yet</span>
      ) : url ? (
        <>
          <a className="truncate mono" href={url} target="_blank" rel="noreferrer" title={url}>
            {url}
          </a>
          <button
            type="button"
            className="btn btnSmall"
            onClick={() =>
              copyToClipboard(url).then(
                () => toast.success(`${label} link copied.`),
                (err) => toast.error(err.message),
              )
            }
          >
            Copy
          </button>
        </>
      ) : (
        <span className="muted small">not generated yet</span>
      )}
    </div>
  );
}

/**
 * The three outputs of one article: the same metadata bound to the standard, feature and list
 * designs, each with its own image crop. The website gets the same HTML and CSS through the
 * public news API, so it renders exactly as in this preview. Each card lists its CDN links below.
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
        const imageUrl = variantImageUrl(card, key);
        return (
          <figure key={key} className={`outputCard outputCard-${design}`}>
            <figcaption className="outputHeader">
              <strong>{label}</strong>
              <span className="muted small">
                {size.width}×{size.height}
                {!imageUrl && " · image not generated yet"}
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
            <div className="cdnLinks">
              <CdnLink label="Image" url={imageUrl} />
              <CdnLink label="Logo" url={card.cdn_publisher_logo_url} />
            </div>
          </figure>
        );
      })}
    </div>
  );
}
