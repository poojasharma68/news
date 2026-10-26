/**
 * CARD_CSS is the complete design of the three card types. The dashboard preview and the
 * exported HTML both use it, so what an editor reviews is exactly what goes live.
 * Every rule is scoped under a card root class (.newsCard, .newsCardFeature, .newsCardList)
 * so it cannot restyle anything else on the website. The image box ratio comes from
 * --news-card-image-ratio and defaults to each variant's configured crop.
 */

export const CARD_CSS = `
.newsCard,
.newsCardFeature,
.newsCardList {
    box-sizing: border-box;
    font-family: var(--news-card-font, "Inter", "Segoe UI", system-ui, -apple-system, sans-serif);
    color: #111111;
}

.newsCard *,
.newsCardFeature *,
.newsCardList * {
    box-sizing: border-box;
}

.newsCard p,
.newsCardFeature p,
.newsCardList p {
    margin: 0;
}

.newsCard .belowHeading,
.newsCard .cardSubText,
.newsCardFeature .featureTitle,
.newsCardList .listTitle {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
}

/* Standard: image on top, logo band, publisher + date, title, description, Read More */

.newsCard {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 402px;
    height: 100%;
    max-height: var(--news-card-max-height, 434px);
    background: #ffffff;
    border: 1px solid #ececec;
    border-radius: 12px;
    overflow: hidden;
}

.newsCard > img {
    display: block;
    width: 100%;
    aspect-ratio: var(--news-card-image-ratio, 402 / 196);
    object-fit: cover;
    background: #f1f1f1;
}

.newsCard .publisherLogoBand {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 9px 18px;
    border-bottom: 1px solid #ececec;
}

/* Logos keep their own ratio and are never upscaled; only their height is capped. */
.newsCard .publisherLogo,
.newsCardFeature .publisherLogo {
    display: block;
    width: auto;
    max-width: 100%;
    height: auto;
}

.newsCard .publisherLogo {
    max-height: 28px;
}

.newsCard .newsCardContent {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    padding: 0 16px 16px 16px;
}

.newsCard .upperContent {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 0;
    border-bottom: 1px solid #ececec;
}

.newsCard .cardHeading {
    font-size: 14px;
    font-weight: 600;
    color: #2b2b2b;
}

.newsCard .publishDate {
    font-size: 12px;
    color: #2b2b2b;
    white-space: nowrap;
}

.newsCard .middleBelowTxt {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 12px;
}

.newsCard .belowHeading {
    font-size: 16px;
    font-weight: 700;
    line-height: 1.3;
}

.newsCard .cardSubText {
    font-size: 14px;
    line-height: 1.45;
    color: #555555;
}

.newsCard .redirectDivi {
    display: flex;
    justify-content: flex-end;
    margin-top: auto;
    padding-top: 8px;
}

.newsCard .redirectDivi a {
    font-size: 14px;
    font-weight: 600;
    color: #111111;
    text-decoration: none;
}

.newsCard .redirectDivi a:hover {
    text-decoration: underline;
}

/* Feature: the whole card is the link; date badge top right, logo and title over a gradient */

.newsCardFeature {
    position: relative;
    display: block;
    width: 100%;
       max-width: 335px;
    aspect-ratio: var(--news-card-image-ratio, 379 / 338);
    overflow: hidden;
    isolation: isolate;
    background: #111111;
    border-radius: 16px;
    color: #ffffff;
    text-decoration: none;
}

.newsCardFeature .featureImage {
    position: absolute;
    inset: 0;
    z-index: -2;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.4s ease;
}

.newsCardFeature::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.92) 0%, rgba(0, 0, 0, 0.6) 35%, rgba(0, 0, 0, 0) 65%);
}

.newsCardFeature:hover .featureImage {
    transform: scale(1.04);
}

.newsCardFeature:focus-visible {
    outline: 3px solid #2563eb;
    outline-offset: 3px;
}

.newsCardFeature .featureDate {
    position: absolute;
    top: 12px;
    right: 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: rgba(17, 17, 17, 0.55);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
}

.newsCardFeature .featureContent {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 20px 18px 18px;
}

/* The logo is shown in white over the photo. Inverted to greyscale, dark marks turn white and a
   white or light background turns black; "screen" then drops the black, so no box is left and
   light details inside a mark (the letters in a coloured badge) show the photo through them. */
.newsCardFeature .publisherLogo {
    max-width: 100%;
                max-width: 200px;
            max-height: 35px;
            min-height: 20px;
    filter: grayscale(1) invert(1) brightness(2.6);
    mix-blend-mode: screen;
}

.newsCardFeature .featurePublisher {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.85;
}

.newsCardFeature .featureTitle {
    font-size: 14px;
    font-weight: 400;
    line-height: 1.35;
}

/* List: image left; publisher pill, title, date, divider, View Article */

.newsCardList {
    display: flex;
    gap: 20px;
    width: 100%;
    max-width: 600px;
    padding: 16px;
    background: #ffffff;
    border-radius: 20px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06);
}

.newsCardList .listImage {
    display: block;
    flex: 0 0 244px;
    width: 244px;
    aspect-ratio: var(--news-card-image-ratio, 244 / 170);
    object-fit: cover;
    background: #f1f1f1;
    border-radius: 12px;
}

.newsCardList .listContent {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
    padding: 4px 0;
}

.newsCardList .listPublisher {
    max-width: 100%;
    padding: 5px 12px;
    overflow: hidden;
    background: #1a1a1a;
    border-radius: 999px;
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
}

.newsCardList .listTitle {
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
}

.newsCardList .listDate {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #555555;
}

.newsCardList .listLink {
    display: inline-flex;
    align-items: center;
    align-self: stretch;
    gap: 6px;
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid #ececec;
    color: #111111;
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
}

.newsCardList .listLink svg {
    transition: transform 0.2s ease;
}

.newsCardList .listLink:hover svg {
    transform: translate(2px, -2px);
}

@media (max-width: 420px) {
    .newsCardList {
        flex-direction: column;
    }

    .newsCardList .listImage {
        flex-basis: auto;
        width: 100%;
    }
}
`;
