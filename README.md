# News Card Studio — Masters' Union

Admin dashboard that turns a list of news article URLs into ready-to-publish news cards for the Masters' Union website.

Paste 10–20 links → metadata and featured images are extracted → each article's image is resized into **three variants (large, medium, small)** and uploaded to **your existing CDN** → everything is stored in **Supabase** → editors review, correct and approve → the **three card outputs** (the existing `.newsCard` markup, one per placement) are exported or read through the API.

One article URL = one master record. The three outputs are derived from that record on demand, so an edit updates all of them and they can never drift apart.

---

## Contents

1. [Architecture](#architecture)
2. [Quick start](#quick-start)
3. [Database setup (Supabase)](#database-setup-supabase)
4. [CDN configuration](#cdn-configuration)
5. [Configuration reference](#configuration-reference)
6. [How processing works](#how-processing-works)
7. [CAPTCHA and blocked publishers](#captcha-and-blocked-publishers)
8. [News card HTML](#news-card-html)
9. [Testing](#testing)
10. [Manual testing checklist](#manual-testing-checklist)
11. [Deployment](#deployment)
12. [Security notes](#security-notes)
13. [Open items that need your input](#open-items-that-need-your-input)
14. [Three card outputs](#three-card-outputs)
15. [Approval and publishing workflow](#approval-and-publishing-workflow)
16. [Website API](#website-api)

---

## Architecture

```text
src/                         React dashboard (Vite)
  components/
    BulkUrlInput/            paste, validate, de-duplicate, review URLs
    ProcessingQueue/         per-article stage/status, retry/cancel, batch progress
    NewsCardEditor/          edit metadata, replace thumbnail, approve, copy HTML
    NewsCardPreview/         sandboxed iframe rendering the exact export HTML
    CardOutputs/             the three outputs (large/medium/small) side by side
    WorkflowSteps/           fetch → content approval → publish gates
    ActivityLog/             per-card event history
    NewsLibrary/             "Manage news": search, filters, pagination, row and bulk actions
  pages/                     Dashboard, NewsCards (library + editor), Login
  lib/                       API client, Supabase sign-in, hooks

shared/                      used by BOTH dashboard and API
  htmlGenerator.js           the three card designs (standard/feature/list), escaping, dates
  newsCardStyles.js          the complete card CSS, shared by the preview and the export
  urlUtils.js                URL parsing, validation, de-duplication keys
  types.js                   statuses, card variants, completeness rules

server/                      Node.js + Express API
  routes/news.routes.js      REST endpoints
  services/
    articleExtractor.js      orchestration: metadata → browser → RSS/API → manual
    metadataParser.js        Open Graph → Twitter → JSON-LD → HTML
    browserFallback.js       Playwright rendering (fresh context, SSRF-filtered)
    alternativeSources.js    publisher API adapters + RSS/Atom feeds
    challengeDetector.js     CAPTCHA / Cloudflare / access-denied detection
    hostLimiter.js           per-publisher rate limiting + blocked-host memory
    imageProcessor.js        Sharp validation, crop/resize, hashing
    cdnAdapter.js            integration with your existing CDN
    pipeline.js              per-article pipeline stages, variant + logo uploads
    events.js                card activity log (news_card_events)
    processingQueue.js       bounded concurrency, retries, cancellation
    newsService.js           batches, dedupe, edits, approval, export
    supabaseService.js       Supabase repository
  middleware/                validation (zod), auth, error handling
  lib/                       SSRF guard, safe fetch, errors, logger

supabase/migrations/         SQL schema, indexes, RLS policies
tests/                       Vitest unit + integration tests
```

The card HTML generator lives in `shared/`, so the live preview and the exported file are produced by the same function and are byte-identical.

---

## Quick start

Requirements: **Node.js 20.10+** (tested on Node 24), a Supabase project.

```bash
npm install
cp .env.example .env            # then fill in the values (see below)
npm run playwright:install      # optional: Chromium for the JavaScript-rendering fallback
npm run dev                     # API on :8787, dashboard on http://localhost:5173
```

The minimum `.env` for local development:

```ini
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key>     # server only
AUTH_MODE=none                                   # local only; use "supabase" everywhere else
CDN_PROVIDER=local-dev                           # local only; stores images in ./dev-cdn-uploads
```

`AUTH_MODE=none` and `CDN_PROVIDER=local-dev` are **refused when `NODE_ENV=production`**.

Other commands:

| Command | Purpose |
|---|---|
| `npm test` | Run the test suite |
| `npm run build` | Build the dashboard (`dist/`) |
| `npm start` | Run the API (`node server/index.js`) |

---

## Database setup (Supabase)

1. Create a Supabase project.
2. Apply **all** migrations in `supabase/migrations/` in order (they are additive and safe to re-run):
   - **Supabase CLI:** `supabase link --project-ref <ref>` then `supabase db push`, or
   - **Dashboard:** SQL Editor → paste the file → Run.
3. In **Authentication → Users**, create accounts for the editors (email + password). Disable public sign-ups in **Authentication → Providers → Email** if only invited editors should have access.
4. Set `ADMIN_EMAILS` in `.env` to the allowed addresses and/or domains, e.g. `ADMIN_EMAILS=@mastersunion.org,designer@agency.com`.
5. Optional, for direct table access with an editor's own session (RLS): add them to `admin_users`:
   ```sql
   insert into public.admin_users (email) values ('editor@mastersunion.org');
   ```
6. Copy **Project URL**, **anon key** (browser, sign-in only) and **service_role key** (server only) from **Project Settings → API** into `.env`.

What the migration creates:

| Object | Purpose |
|---|---|
| `news_cards` | One row per article: full title/description, URLs, image fields, status, stage, errors, approval |
| `news_batches` | One row per "Fetch All News" submission, including skipped links |
| `processed_images` | Cache of uploaded thumbnails keyed by image hash + output size, so identical images are uploaded once |
| `admin_users`, `is_news_admin()` | Allow-list used by Row Level Security policies |
| `news_card_stats()` | Status counts for the dashboard |
| `news_cards.image_variants` | `{ large, medium, small }` → `{ url, width, height }` on the CDN (2026-10-19 migration; existing thumbnails are back-filled as `large`) |
| `news_card_events` | Append-only history per card: event, status, message, actor, job correlation id. Deleted with the card. RLS: admins read, only the API writes |

De-duplication: a unique index on `source_url_key` (normalised submitted URL) and a partial unique index on `canonical_url_key`. RLS is enabled on every table. The `anon` role has no access. Authenticated users can read and write only when listed in `admin_users`. The API uses the service-role key, never sends it to the browser, and enforces admin auth itself.

---

## CDN configuration

> **The CDN API details are not available in this repository, so no endpoint, field names or response shape were assumed.** The `cdnAdapter` is driven entirely by configuration. To finish the integration, set the variables below from your CDN's documentation.

| Variable | Meaning | Example |
|---|---|---|
| `CDN_PROVIDER` | `http` = your CDN, `local-dev` = disk (dev only), `none` = not configured | `http` |
| `CDN_UPLOAD_URL` | Upload / convert endpoint | `https://cdn-api.example.com/v1/upload` |
| `CDN_HTTP_METHOD` | `POST` or `PUT` | `POST` |
| `CDN_UPLOAD_MODE` | `multipart` (form file upload), `raw` (bytes as body) or `url-json` (CDN fetches the image from a URL) | `multipart` |
| `CDN_FILE_FIELD` | Form field for the file (`multipart`) | `file` |
| `CDN_URL_FIELD` | JSON field for the source URL (`url-json`) | `url` |
| `CDN_EXTRA_FIELDS` | Static extra fields as JSON | `{"folder":"news-cards"}` |
| `CDN_AUTH_HEADER_NAME` / `CDN_AUTH_HEADER_VALUE` | Credential header (kept on the server) | `Authorization` / `Bearer …` |
| `CDN_RESPONSE_URL_PATH` | Dot path to the public URL in the JSON response; `$body` if the body *is* the URL | `data.url` |
| `CDN_PUBLIC_URL_PREFIX` | Returned URLs must start with this (rejects unexpected responses) | `https://cdn.mastersunion.org/` |
| `CDN_TIMEOUT_MS`, `CDN_MAX_RETRIES` | Timeout and retries for 5xx/429/network errors (4xx is not retried) | `30000`, `2` |

Behaviour:
- In `multipart`/`raw` mode the adapter uploads the **processed** thumbnail (resized WebP by default). File names are derived from a content hash (`news-card-<hash>.webp`), so retries never create differently named copies.
- In `url-json` mode the CDN receives the **original publisher image URL** (after the image has been validated). Any resizing must then be requested through `CDN_EXTRA_FIELDS`, because the CDN fetches the image itself.
- Successful uploads are recorded in `processed_images`. Re-running a job or processing the same image for another card reuses the CDN URL instead of uploading again.
- If the CDN is not configured, extraction still runs and is saved. Those cards fail at the upload stage with `CDN_NOT_CONFIGURED` and can be retried once the CDN is set up.

If your CDN needs something these options can't express (signed requests, multi-step uploads, etc.), implement an adapter with the same methods as the `CdnAdapter` objects in `server/services/cdnAdapter.js` and return it from `createCdnAdapter()`. Nothing else needs to change.

---

## Configuration reference

All settings are documented in `.env.example`. The most relevant ones:

| Variable | Default | Notes |
|---|---|---|
| `MAX_BATCH_SIZE` | `20` | Unique URLs per batch |
| `QUEUE_CONCURRENCY` | `3` | Articles processed in parallel |
| `JOB_MAX_RETRIES` | `2` | Retries for transient failures only (timeouts, 5xx, network) |
| `FETCH_TIMEOUT_MS` | `15000` | Per request, including redirects |
| `PUBLISHER_MIN_INTERVAL_MS` | `2000` | Minimum gap between requests to the same publisher |
| `BLOCKED_HOST_TTL_MS` | `1800000` | How long a publisher that served a CAPTCHA is skipped |
| `CARD_IMAGE_WIDTH` × `CARD_IMAGE_HEIGHT` | `804 × 392` | Standard card image (2× 402×196) |
| `CARD_IMAGE_MEDIUM_WIDTH` × `…_HEIGHT` | `758 × 676` | Feature card image (2× 379×338) |
| `CARD_IMAGE_SMALL_WIDTH` × `…_HEIGHT` | `488 × 340` | List card image (2× 244×170) |
| `CARD_IMAGE_FIT` / `CARD_IMAGE_POSITION` | `cover` / `smart` | Automatic crop used until an editor sets one; `smart` keeps people, faces and detailed regions in frame without cutting through them and reports its box to the editor, `attention` is Sharp's built-in crop, `centre` is a plain middle crop |
| `CARD_IMAGE_FORMAT` / `CARD_IMAGE_QUALITY` | `webp` / `82` | `jpeg`, `png`, `avif` also supported |
| `CARD_DATE_LOCALE` / `CARD_DATE_MONTH` / `CARD_DATE_TIMEZONE` | `en-US` / `short` / `Asia/Kolkata` | Produces e.g. `Oct 12, 2026` |
| `BROWSER_FALLBACK_ENABLED` | `true` | Uses Playwright only when static metadata is incomplete |
| `RSS_FALLBACK_ENABLED` | `true` | Looks up the article in the publisher's public feeds |

---

## How processing works

```text
URL validation → metadata extraction → image validation → image processing
→ CDN upload → Supabase persistence → preview
```

- Each URL becomes its own job. A failure, timeout or CAPTCHA affects only that article.
- The current stage and status are saved on the card after each step. Refreshing the page loses nothing, and jobs that were queued or running when the server stopped are re-queued on startup.
- **Extraction priority:** Open Graph → Twitter Card → JSON-LD → standard HTML metadata → Playwright rendering (only if title, image or description is still missing) → publisher API adapters / RSS feeds.
- Missing values are never invented. Full titles and descriptions are stored; the two-line limit is applied only with CSS.
- **Featured image choice:** declared images (`og:image`, `twitter:image`, JSON-LD) are preferred. Logos, icons, avatars, ad images and SVGs are filtered out. An image taken from the article body is flagged for review. If an image is broken, the next candidate is tried.
- **Retries:** transient errors are retried with exponential backoff. Permanent errors (404, unsafe URL, not a web page) and CAPTCHAs are not. Retrying never overwrites fields that are already filled, and a card that already has a CDN image is never uploaded again.
- **Duplicates:** links that normalise to the same URL are merged before processing. A link whose canonical URL matches an existing card is marked `duplicate` instead of creating a second card. Resubmitting a failed link re-queues the existing card.

Statuses:

| Status | Meaning |
|---|---|
| `queued`, `processing` | In the pipeline |
| `completed` | All fields and CDN image present; awaiting approval |
| `needs_review` | Complete, but with warnings (e.g. thumbnail taken from the article body, upscaled image) |
| `partial_data` | Some fields are missing; complete them in the editor |
| `verification_required` | Publisher blocked automated access; complete the card manually |
| `approved` | Explicitly approved by an editor; all three outputs are ready (= "ready to publish") |
| `published` | An editor confirmed the exported HTML is live (no automatic publishing exists) |

How these map onto the workflow states in the brief:

| Brief | This system |
|---|---|
| `pending` | `queued` |
| `fetching` / `processing` | `processing` (the `processing_stage` column says which: `extracting`, `processing_image`, `uploading`, …) |
| `captcha_required` | `verification_required` |
| `fetch_failed` | `failed` (with `error_code` / `error_message`) |
| `manual_review` | `partial_data`, `needs_review`, `completed` |
| `approved` + `ready_to_publish` | `approved` (approval requires all fields and all three image variants) |
| `published` | `published`, set only by an explicit editor confirmation |
| `failed` | Error shown on the card; retry when possible |
| `cancelled`, `duplicate` | Cancelled before start / same article as another card |

---

## CAPTCHA and blocked publishers

The system **detects** challenge pages and **does not try to get around them**.

1. Cloudflare, PerimeterX, DataDome, Imperva, reCAPTCHA/hCaptcha/Turnstile pages and 401/403/429/451 responses are detected, both in the plain HTML and in the Playwright-rendered page.
2. The publisher is remembered as blocked for `BLOCKED_HOST_TTL_MS`. Other links from the same site in the batch skip the direct request instead of hitting it again.
3. Permitted alternatives are tried: configured publisher APIs, then the site's public RSS/Atom feeds (at most 4 requests). If a feed is also challenged, the attempt stops.
4. Any partial data found is saved, and the card is set to `verification_required` with the reason shown in the dashboard.
5. The editor opens the article in their own browser, then enters the missing fields and pastes an image URL or uploads the image. Saving resumes the pipeline from the image stages.

Approving a blocked card does **not** get past the CAPTCHA: approval is refused with `next_action: "complete_manually"` and the dashboard says so. Retrying a blocked card is allowed at most `MAX_BLOCKED_ATTEMPTS` (3) times in total; after that the card can only be completed manually.

No CAPTCHA solutions, cookies or session credentials are stored. Each Playwright render uses a fresh browser context. To add an official publisher API, add an adapter to `PUBLISHER_API_ADAPTERS` in `server/services/alternativeSources.js`.

---

## News card HTML

The generator (`shared/htmlGenerator.js`) outputs exactly the existing structure, with all class names preserved:

```html
<div class="newsCard">
    <img
        src="CDN_IMAGE_URL"
        alt="ARTICLE_TITLE"
    >
    <div class="newsCardContent">
        <div class="upperContent"> <p class="cardHeading">…</p> <p class="publishDate">…</p> </div>
        <div class="middleBelowTxt"> <p class="belowHeading">…</p> <p class="cardSubText">…</p> </div>
        <div class="redirectDivi"> <a class="btnBlack outline btnSm" target="_blank" rel="noopener noreferrer" href="ARTICLE_URL">Read More</a> </div>
    </div>
</div>
```

- All text and attribute values are HTML-escaped. Only `http(s)` URLs are emitted; anything else becomes `#`.
- `src` is always the CDN URL. `href` is the canonical article URL, falling back to the submitted URL.
- Exports include only **approved** or **published** cards. The "Include 2-line clamp CSS" option adds `CARD_CLAMP_CSS`: line clamping, plus flex rules that keep **Read More** aligned across cards of different heights.

**Add this CSS to the website once** if the existing stylesheet does not already clamp text:

```css
.newsCard .belowHeading,
.newsCard .cardSubText {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
}
```

The dashboard preview uses an approximation of the card design (`CARD_PREVIEW_CSS`). To make the preview pixel-accurate, replace that constant with the website's real card stylesheet.

---

## Testing

```bash
npm test
```

110 tests cover (all external services are mocked; no publisher or CDN is contacted):

- **URL handling:** parsing, validation and normalisation, plus SSRF blocking (private/reserved IPv4 and IPv6, IPv4-mapped/NAT64, decimal/hex IP tricks, internal host names, DNS resolving to private addresses).
- **Extraction:** metadata priority (OG, Twitter, JSON-LD `@graph`, malformed JSON-LD), relative image URLs, logo filtering, canonical validation, dates in IST, challenge detection and avoiding false positives, RSS parsing, the blocked-host skip, browser fallback, and 404/5xx classification.
- **Images and CDN:** crop/resize output, cache keys, rejecting SVG and corrupt or tiny images, content-type checks, CDN multipart upload, retries and URL validation.
- **Queue:** concurrency limit, bounded retries, permanent failures, cancellation, duplicate enqueue.
- **End-to-end pipeline** (in-memory repository): completion, in-batch/library/canonical de-duplication, CDN retry without duplicate uploads, cross-card upload reuse, CAPTCHA → manual completion → resume, partial data → approval → export, export restrictions, bulk retry skipping permanent failures.
- **HTML generation:** exact markup snapshot, XSS escaping, URL scheme filtering, date time zones, bulk export.
- **HTTP API** (supertest): validation, batch limits, edit/upload/approve/export/delete flow, logo upload, bulk retry, outputs/events, reads never starting jobs, auth (401 and 403 for non-admins) and production config guards.
- **Workflow** (`tests/workflow.test.js`): one URL → one record with three variants at the configured sizes, canonical de-duplication, three outputs that differ only in the image, edits updating every output, image changes regenerating all variants, legacy cards back-filling missing variants, separate manual logos, CAPTCHA → refused approval with next step → capped retries, per-article bulk results, publish only on confirmation, partial CDN failure recovery without duplicate uploads, restart recovery, and correlated job events.

---

## Manual testing checklist

Setup
- [ ] Migration applied; `news_cards`, `news_batches`, `processed_images`, `admin_users` exist with RLS enabled
- [ ] `npm run dev` starts both servers; `GET /api/health` returns `{ "ok": true }`
- [ ] Signing in with an allow-listed editor works; a non-allow-listed account gets "not authorised"

Bulk input
- [ ] Paste 10–20 URLs from Google Sheets (one column) → all are detected
- [ ] Invalid entries (`javascript:…`, plain text) are listed with reasons
- [ ] The same URL with `?utm_source=…` or `#fragment` is reported as a duplicate
- [ ] More than `MAX_BATCH_SIZE` unique URLs disables submission with a message
- [ ] "Review URLs before processing" shows the review list; "Clear All" empties the input

Processing
- [ ] Each article shows its own stage and status; the batch progress bar advances
- [ ] Refreshing the page mid-batch keeps the progress; restarting the API resumes queued jobs
- [ ] A 404 link fails with a clear message while the others complete
- [ ] A link from a publisher that shows a CAPTCHA becomes "Verification required" and does not stop the batch
- [ ] "Cancel queued" cancels jobs that have not started; "Retry eligible failed" re-queues only retryable failures
- [ ] Submitting the same links again creates no duplicate cards

Editor and preview
- [ ] Editing title, description, publisher, date or URL updates the live preview immediately
- [ ] Long titles and descriptions are clamped to two lines in the preview, but the full text is saved
- [ ] Choosing another image candidate or pasting an image URL, then saving, re-processes the thumbnail
- [ ] Uploading a JPEG/PNG/WebP replaces the thumbnail; an SVG or oversized file is rejected
- [ ] For a verification-required card: open the article, fill in the fields, upload an image, save → status becomes "Ready for review"
- [ ] Approve stays disabled while fields are missing or changes are unsaved

Library and export
- [ ] Search by title and publisher, and filter by status and publication date
- [ ] Pagination works with more than 20 cards
- [ ] Bulk approve reports cards that could not be approved and why
- [ ] "Export HTML file" downloads approved cards only, using CDN image URLs and the original article URLs
- [ ] "Copy HTML" copies snippets and shows a confirmation
- [ ] The exported HTML pasted into the website renders correctly with the existing styles
- [ ] "Confirm live on website" (after a confirmation dialog) moves approved cards to Published; deleting a card asks for confirmation
- [ ] Ticking checkboxes starts nothing; "Approve selected" / "Retry selected" ask for confirmation and list every article's outcome
- [ ] "Preview" shows the large, medium and small outputs side by side; the editor shows them live while you type
- [ ] A blocked (CAPTCHA) card shows the manual steps; approving it is refused with that next step

---

## Deployment

The API is a long-running Node process (it hosts the queue and, optionally, a headless browser). Deploy it to a VM, container or PaaS such as Render, Railway, Fly.io or ECS. **Serverless functions are not suitable** for the API.

### Option A — single service (simplest)

```bash
npm ci
npm run build
NODE_ENV=production SERVE_CLIENT=true npm start
```

The API serves the dashboard from `dist/`. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` **at build time**, and all server variables at runtime. Behind a load balancer, set `TRUST_PROXY=1`.

Example Dockerfile:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production SERVE_CLIENT=true PORT=8787
EXPOSE 8787
CMD ["node", "server/index.js"]
```

(Use `node:20-slim` instead, and set `BROWSER_FALLBACK_ENABLED=false`, if you don't need the Playwright fallback.)

### Option B — separate frontend and backend

- **Dashboard:** `npm run build` → deploy `dist/` to any static host (Vercel, Netlify, S3 + CloudFront). Set `VITE_API_BASE_URL=https://api.your-domain`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- **API:** `npm start` on a Node host (no build step). Set `CORS_ORIGIN=https://dashboard.your-domain`.

Build with `NODE_ENV=production` (or without `NODE_ENV=development` in `.env`): Vite reads `NODE_ENV` from `.env`, and a development value produces a development React build.

### Production checklist

- `NODE_ENV=production`, `AUTH_MODE=supabase`, `ADMIN_EMAILS` set
- `CDN_PROVIDER=http` with `CDN_PUBLIC_URL_PREFIX` set
- HTTPS everywhere; the service-role key only in the server's secret store
- Run **one** API instance: the queue is in-process. To scale out, move the queue to a shared broker such as pg-boss or BullMQ.

---

## Security notes

- **SSRF:** only `http(s)` on ports 80/443; no credentials in URLs; internal host names are blocked. Private, loopback, link-local, metadata, CGNAT, multicast and reserved IPv4/IPv6 ranges are blocked. DNS is checked at connect time, which defeats rebinding. Every redirect hop is re-validated. Playwright requests are filtered the same way.
- **Limits:** response size caps (HTML 3 MB, images 10 MB); request timeouts; image pixel limit; SVG refused; content type validated by magic bytes.
- **Output:** all card output is escaped; only `http(s)` links are emitted. The preview runs in a sandboxed iframe with no script execution.
- **API:** validation with zod; rate limiting (global and per batch submission); helmet security headers and CSP; generic 500 errors (details are logged server-side with secrets redacted).
- **Secrets:** environment-only; `.env` is git-ignored; `.env.example` contains placeholders only.

---

## Open items that need your input

1. **CDN API details:** endpoint, auth method, request format and response shape. Then set the `CDN_*` variables, or implement a custom `CdnAdapter` if needed.
2. **Website card dimensions and stylesheet:** set `CARD_IMAGE_WIDTH`/`CARD_IMAGE_HEIGHT` to the real image box, and paste the real card CSS into `CARD_PREVIEW_CSS` for a pixel-accurate preview.
3. **Date format:** confirm the website's format (`Oct 12, 2026` by default; adjust `CARD_DATE_*`).
4. **Publisher APIs:** if you have licensed access to any publisher's content API, add an adapter in `alternativeSources.js`.
5. **The three card placements:** the repository contains one card design (`.newsCard`). The three outputs reuse it unchanged with three image sizes. Confirm the real image box of each placement and set `CARD_IMAGE_*`; if a placement uses different markup, add it as its own template in `shared/htmlGenerator.js`.
6. **Website publishing:** no publishing API or deployment hook exists. To publish automatically, provide the website's API (or CMS) and add it behind the "Confirm live" action so `published` is only set after a verified success.

---

## Three card outputs

`shared/types.js` defines `CARD_VARIANTS` (`large`, `medium`, `small`). For every article:

```text
master record (news_cards row)
 ├─ shared: title, description, publisher, published_at, article URL, publisher logo
 ├─ large  → standard card (.newsCard, image on top)        402×196 on page → 804×392  CARD_IMAGE_WIDTH × HEIGHT
 ├─ medium → feature card (.newsCardFeature, text on image)  379×338 on page → 758×676  CARD_IMAGE_MEDIUM_*
 └─ small  → list card (.newsCardList, image left)           244×170 on page → 488×340  CARD_IMAGE_SMALL_*
```

- All card styling lives in `shared/newsCardStyles.js` (`CARD_CSS`). The dashboard preview renders the exported HTML with exactly this CSS, and "Copy HTML" and exports with `includeStyles` include it, so the reviewed card is the card that goes live. Every rule is scoped under the card root classes and does not touch other website styles.
- Every image fills its card. Padding a publisher added around the photo (a blurred, stretched copy of it, plain bars, or both nested) is detected and cut off before cropping, so no blur reaches a card. The automatic crop (`CARD_IMAGE_POSITION=smart`) scores every possible frame on skin tones, detail and colour, avoids edges that run through a person, and stores the frame it chose (`image_variants.<card>.auto`) so the editor shows it exactly.
- When it picks the wrong part, the editor fixes it per card in **Crop** (Thumbnail section), as in Figma's crop mode: a tab for each card; drag the box over the original image, drag a corner or scroll to zoom, use the zoom slider, arrow keys and +/-; or drag and scroll inside a card preview to move the picture in its frame. **Fit & centre** returns to the largest centred box, **Automatic** to the server's crop. Every card has its own crop, because the same photo needs a different crop at a different shape. `PATCH /api/cards/:id` takes `image_focus: { large?: {x, y, zoom?} | null, medium?: …, small?: … }` (x/y 0–1 as CSS `object-position`, zoom 1–6 shrinks the box); only the cards sent change, `null` sends one card back to the automatic crop, and only the changed images are uploaded again. The server crops with the same rule as the preview, so the preview matches the result. Changing a crop needs approval again.
- Uploaded images are also stored on the CDN unchanged (`original_image_url`), so they can be re-cropped later. Run the migration `20261020000000_image_focus.sql`.
- Logos keep their own ratio and are never upscaled: up to 40px tall on the standard card, 33px on the feature card.
- Image sizes are 2× the on-page image box. When the design sizes change, update the `CARD_IMAGE_*` variables and regenerate the images; existing images are still cropped to the right shape by CSS (`object-fit: cover`).

- The pipeline downloads the featured image once, produces all three variants with Sharp (crop, WebP) and uploads each to the CDN. File names are derived from a hash of the source bytes and the output spec, and every upload is recorded in `processed_images`, so a retry after a partial failure only uploads the variants that are missing.
- Changing the image URL or uploading a new image clears all variants and regenerates them together. Changing text needs no reprocessing: outputs are generated from the record.
- `GET /api/cards/:id/outputs` returns `{ article, outputs: [{ variant, label, image: { url, width, height }, html }] }` for a website integration. `POST /api/cards/export` takes `variant` (`large` by default).
- With `CDN_UPLOAD_MODE=url-json` the CDN fetches the original itself and cannot receive three resized files; all three variants then point to the same ingested URL. Use `multipart` or `raw` mode for real variants.
- The publisher logo is stored separately (`publisher_logo_url` / `cdn_publisher_logo_url`), can be uploaded by hand (`POST /api/cards/:id/logo`, SVG/PNG/WebP/JPEG/GIF ≤ 2 MB, rasterised to WebP) and is only added to the markup when `CARD_SHOW_PUBLISHER_LOGO=true`.

## Approval and publishing workflow

Each card passes three separate gates, shown at the top of the editor:

1. **Fetch** — automatic extraction. Blocked or failed fetches are completed manually or retried (`POST /api/cards/retry` for several at once).
2. **Content approval** — `POST /api/cards/approve`. Only complete cards with all three variants are approved; every other card is returned with a `reason` and a `next_action` (`complete_manually`, `retry_or_edit`, `complete_fields`, `wait`, `resolve_duplicate`).
3. **Publish** — **Save final changes** (`POST /api/cards/publish`) saves the approved version as the live version (`news_cards.live_card`), which the [website API](#website-api) serves. Edits after that stay off the website until the card is approved and saved again; **Remove from website** (`POST /api/cards/unpublish`) takes it down. Run the migration `20261026000000_live_cards.sql`.

Selecting rows never triggers processing. Bulk actions ask for confirmation and list the outcome for every selected article. Every step is written to `news_card_events` with the acting editor and, for background jobs, a correlation id shared by all attempts of that job (also present in the server logs as `jobId`).

---

## Website API

Public, read-only, no sign-in, callable from any origin (`Access-Control-Allow-Origin: *`). It serves only cards saved with **Save final changes**, newest article first, cached for 60 seconds.

| Endpoint | Returns |
|---|---|
| `GET /api/public/news?limit=12&offset=0` | `{ items, total, limit, offset }` (limit 1–50) |
| `GET /api/public/news/:id` | one live card, or 404 |
| `GET /api/public/news.css` | the card CSS for the `html` below |
| `GET /api/public/embed.js` | drop-in script that renders cards into the page |

Each item:

```json
{
  "id": "…", "title": "…", "description": "…", "publisher": "…",
  "published_at": "2026-10-12T00:00:00.000Z", "publish_date_label": "Oct 12, 2026",
  "article_url": "https://…", "publisher_logo_url": "https://…",
  "images": { "large": { "url": "…", "width": 804, "height": 392 }, "medium": { … }, "small": { … } },
  "html":   { "large": "<div class=\"newsCard\">…", "medium": "…", "small": "…" },
  "live_since": "2026-10-26T10:00:00.000Z"
}
```

Use the fields with your own markup, or the ready-made `html` (escaped by the server) with `news.css`. The simplest binding:

```html
<div data-mu-news="small" data-limit="6"></div>   <!-- large | medium | small -->
<script src="https://<api-host>/api/public/embed.js" defer></script>
```

The script loads the CSS once, fills every `[data-mu-news]` element and fires `mu-news:loaded` (or `mu-news:error`) on it.
