/**
 * Processed images and logos are kept on the API server (served at /dev-cdn/) until an editor
 * clicks "Convert to CDN". With CDN_PROVIDER=local-dev that store is the CDN itself.
 */
export function isLocalImageUrl(url, cdnProvider) {
  return !!url && cdnProvider !== "local-dev" && url.includes("/dev-cdn/");
}

/**
 * Whether Convert to CDN has something to upload: an image or logo still stored locally, or a
 * logo with a source URL that was never stored.
 */
export function cardNeedsCdn(card, cdnProvider) {
  const urls = [
    ...Object.values(card.image_variants ?? {}).map((v) => v?.url),
    card.cdn_image_url,
    card.cdn_publisher_logo_url,
  ];
  return (
    urls.some((url) => isLocalImageUrl(url, cdnProvider)) ||
    (!card.cdn_publisher_logo_url && !!card.publisher_logo_url)
  );
}
