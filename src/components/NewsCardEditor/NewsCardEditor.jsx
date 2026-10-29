import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toDateInputValue } from "../../../shared/htmlGenerator.js";
import {
  ACTIVE_STATUSES,
  APPROVABLE_STATUSES,
  CARD_VARIANTS,
  computeMissingFields,
  FIELD_LABELS,
  focusFor,
  MAX_BLOCKED_ATTEMPTS,
  RETRYABLE_STATUSES,
  sameFocus,
  STAGE_LABELS,
} from "../../../shared/types.js";
import { api } from "../../lib/api";
import { useAppConfig } from "../../lib/config";
import { navigate, useInterval } from "../../lib/hooks";
import { cardNeedsCdn } from "../../lib/localImages";
import {
  buildBookmarklet,
  IMPORT_MESSAGE_TYPE,
  pageImportImage,
  pageImportLogo,
  parsePageImport,
  sameSite,
} from "../../lib/pageImport";
import { CardOutputs } from "../CardOutputs/CardOutputs";
import { FocusPicker } from "../FocusPicker/FocusPicker";
import { StatusBadge } from "../StatusBadge";
import { useToast } from "../Toast";
import {
  PUBLISH_CONFIRMATION,
  UNPUBLISH_CONFIRMATION,
  WorkflowSteps,
} from "../WorkflowSteps/WorkflowSteps";

function toForm(card, timeZone) {
  return {
    publisher: card.publisher ?? "",
    published_at: toDateInputValue(card.published_at, timeZone),
    title: card.title ?? "",
    description: card.description ?? "",
    article_url: card.canonical_url ?? card.source_url,
    original_image_url: card.original_image_url ?? "",
    publisher_logo_url: card.publisher_logo_url ?? "",
  };
}

function diff(form, base) {
  const update = {};
  Object.keys(form).forEach((key) => {
    if (form[key] !== base[key])
      update[key] = form[key].trim() === "" ? null : form[key];
  });
  return update;
}

const IMPORT_LABELS = {
  title: "title",
  description: "description",
  publisher: "publisher",
  published_at: "date",
  original_image_url: "image",
  publisher_logo_url: "logo",
  article_url: "article URL",
};

const bookmarklet = buildBookmarklet(window.location.origin);
// React warns about javascript: URLs in JSX, so the bookmark's href is set directly.
const setBookmarkletHref = (el) => el?.setAttribute("href", bookmarklet);
// Versioned: a bookmark saved before v2 does not send the publisher logo and must be re-added.
const BOOKMARK_VERSION = 2;
const BOOKMARK_READY_KEY = `mu-news-bookmark-ready-v${BOOKMARK_VERSION}`;

export function NewsCardEditor({ cardId }) {
  const config = useAppConfig();
  const toast = useToast();
  const tz = config.date_format.timeZone;
  const [card, setCard] = useState(null);
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
  // Applied crops shown in the outputs but not on the CDN yet: { image_focus, variants }.
  const [cropPreview, setCropPreview] = useState(null);
  // Set once the bookmark has delivered page details, so the setup step can stay collapsed.
  const [bookmarkReady, setBookmarkReady] = useState(
    () => localStorage.getItem(BOOKMARK_READY_KEY) === "1",
  );
  const fileInput = useRef(null);
  const logoInput = useRef(null);

  const base = useMemo(() => (card ? toForm(card, tz) : null), [card, tz]);
  const changes = useMemo(
    () => (form && base ? diff(form, base) : {}),
    [form, base],
  );
  const dirty = Object.keys(changes).length > 0;

  const applyCard = useCallback(
    (next, resetForm) => {
      setCard(next);
      if (resetForm) setForm(toForm(next, tz));
    },
    [tz],
  );

  const load = useCallback(
    async (resetForm) => {
      try {
        applyCard(await api.getCard(cardId), resetForm);
        setLoadError(null);
      } catch (err) {
        setLoadError(err.message);
      }
    },
    [cardId, applyCard],
  );

  useEffect(() => {
    setCard(null);
    setForm(null);
    void load(true);
  }, [load]);

  // A preview belongs to one original image.
  useEffect(() => setCropPreview(null), [cardId, card?.original_image_url]);

  const processing = !!card && ACTIVE_STATUSES.includes(card.status);
  // While processing, keep refreshing; the form is reset only if the user has not edited it.
  useInterval(() => void load(!dirty), 2000, processing);

  // Warn before leaving with unsaved edits or crops not converted to the CDN.
  const unsaved = dirty || !!cropPreview;
  useEffect(() => {
    if (!unsaved) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [unsaved]);

  const run = async (key, action) => {
    setBusy(key);
    try {
      await action();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const save = (e) => {
    e?.preventDefault();
    if (!card || !dirty) return;
    void run("save", async () => {
      const updated = await api.updateCard(card.id, changes);
      applyCard(updated, true);
      toast.success(
        updated.status === "queued"
          ? "Saved. Processing the new thumbnail…"
          : "Draft saved.",
      );
    });
  };

  const approve = () =>
    card &&
    void run("approve", async () => {
      const result = await api.approve([card.id]);
      if (result.rejected.length) throw new Error(result.rejected[0].reason);
      applyCard(result.approved[0], true);
      toast.success("Card approved. Save the final changes to put it on the website.");
    });

  const publish = () => {
    if (!card || !window.confirm(PUBLISH_CONFIRMATION)) return;
    void run("publish", async () => {
      const result = await api.publish([card.id]);
      if (result.rejected.length) throw new Error(result.rejected[0].reason);
      applyCard(result.published[0], true);
      toast.success("Final changes saved. The website shows this version now.");
    });
  };

  const unpublish = () => {
    if (!card || !window.confirm(UNPUBLISH_CONFIRMATION)) return;
    void run("unpublish", async () => {
      const result = await api.unpublish([card.id]);
      if (result.rejected.length) throw new Error(result.rejected[0].reason);
      applyCard(result.removed[0], true);
      toast.success("Removed from the website.");
    });
  };

  const retry = () =>
    card &&
    void run("retry", async () => {
      applyCard(await api.retryCard(card.id), true);
      toast.info("Processing restarted.");
    });

  const cancel = () =>
    card &&
    void run("cancel", async () => {
      applyCard(await api.cancelCard(card.id), true);
      toast.info("Job cancelled.");
    });

  const remove = () => {
    if (
      !card ||
      !window.confirm(
        "Delete this news card permanently? This cannot be undone.",
      )
    )
      return;
    void run("delete", async () => {
      await api.deleteCard(card.id);
      toast.success("Card deleted.");
      navigate("/library");
    });
  };

  // Key of the last page details applied, so the same details are not imported twice.
  const lastImport = useRef(null);
  const importKey = (message) =>
    `${message?.page}|${JSON.stringify(message?.data ?? null)}`;

  /** Fills the empty form fields with details sent from the article page. */
  const applyImport = useCallback(
    (message) => {
      if (!card || !form) return;
      let fields;
      try {
        fields = parsePageImport(message, card.source_url);
      } catch (err) {
        toast.error(err.message);
        return;
      }
      lastImport.current = importKey(message);
      const outdated = !(message.v >= BOOKMARK_VERSION);
      if (outdated) {
        localStorage.removeItem(BOOKMARK_READY_KEY);
        setBookmarkReady(false);
        toast.info(
          "Your bookmark is out of date and cannot send the logo. Drag the new “Send to News Card Studio” button to your bookmarks bar, replacing the old one.",
        );
      } else {
        localStorage.setItem(BOOKMARK_READY_KEY, "1");
        setBookmarkReady(true);
      }
      const image = pageImportImage(message);
      // An existing logo is kept, like every other field that is already filled in.
      const hasLogo =
        !!card.cdn_publisher_logo_url || !!form.publisher_logo_url.trim();
      const logo = hasLogo ? null : pageImportLogo(message);
      // A file downloaded in the editor's browser replaces its address. When the browser could
      // not download it (the CDN refuses cross-site requests), the address is kept and the
      // server downloads it on save: image CDNs are rarely behind the publisher's CAPTCHA.
      const values = {
        ...fields,
        published_at: toDateInputValue(fields.published_at, tz),
        original_image_url: image ? "" : fields.original_image_url,
        publisher_logo_url: logo || hasLogo ? "" : fields.publisher_logo_url,
      };
      const updates = Object.fromEntries(
        Object.entries(values).filter(
          ([key, value]) => value && !form[key].trim(),
        ),
      );
      const filled = Object.keys(updates).map((key) => IMPORT_LABELS[key]);
      setForm((f) => (f ? { ...f, ...updates } : f));
      if (image || logo)
        void run("upload", async () => {
          // One after the other, so each upload starts from the card the previous one returned.
          if (image) {
            try {
              const updated = await api.uploadThumbnail(card.id, image);
              setCard(updated);
              setForm((f) =>
                f ? { ...f, original_image_url: updated.original_image_url ?? "" } : f,
              );
              toast.success("Article image uploaded; all three sizes are ready locally.");
            } catch (err) {
              setForm((f) =>
                f && !f.original_image_url.trim()
                  ? { ...f, original_image_url: fields.original_image_url }
                  : f,
              );
              toast.error(`The article image could not be uploaded: ${err.message}`);
            }
          }
          if (logo) {
            try {
              const updated = await api.uploadLogo(card.id, logo);
              setCard(updated);
              setForm((f) => (f ? { ...f, publisher_logo_url: "" } : f));
              toast.success("Publisher logo uploaded; it is stored locally until Convert to CDN.");
            } catch (err) {
              // Fall back to the address, which the server tries again on save.
              setForm((f) =>
                f && !f.publisher_logo_url.trim()
                  ? { ...f, publisher_logo_url: fields.publisher_logo_url }
                  : f,
              );
              toast.error(`The publisher logo could not be uploaded: ${err.message}`);
            }
          }
        });
      if (filled.length)
        toast.success(
          `Filled in from the article: ${filled.join(", ")}. Check them, then click Save draft.`,
        );
      else if (!image && !logo)
        toast.info("The page details were received; every field was already filled in.");
    },
    [card, form, tz, toast],
  );

  // Details sent by the bookmark from the article tab opened with "Open article to verify".
  useEffect(() => {
    if (card?.status !== "verification_required") return;
    const onMessage = (e) => {
      if (e.data?.type !== IMPORT_MESSAGE_TYPE) return;
      if (!sameSite(e.origin, card.source_url)) return;
      applyImport(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [card?.status, card?.source_url, applyImport]);

  // When Cloudflare cuts the link between the tabs, the bookmark copies the details instead.
  // Once clipboard access is allowed (first "Paste page details"), they are read on return.
  useEffect(() => {
    if (card?.status !== "verification_required") return;
    const onFocus = async () => {
      try {
        const permission = await navigator.permissions.query({
          name: "clipboard-read",
        });
        if (permission.state !== "granted") return;
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const message = JSON.parse(text);
        if (message?.type !== IMPORT_MESSAGE_TYPE) return;
        if (!sameSite(message.page, card.source_url)) return;
        if (importKey(message) === lastImport.current) return;
        applyImport(message);
      } catch {
        // Clipboard unavailable or not page details: nothing to do.
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [card?.status, card?.source_url, applyImport]);

  // The article tab must keep `window.opener` so the bookmark can send its details back.
  const openForVerification = () => window.open(card.source_url, "_blank");

  const pasteImport = async () => {
    let text = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt("Paste the page details copied by the bookmark:");
    }
    if (!text) return;
    try {
      applyImport(JSON.parse(text));
    } catch {
      toast.error(
        "The clipboard does not contain page details. Click the bookmark on the article page first.",
      );
    }
  };

  const uploadLogo = (file) => {
    if (!card || !file) return;
    void run("logo", async () => {
      const updated = await api.uploadLogo(card.id, file);
      setCard(updated);
      setForm((f) => (f ? { ...f, publisher_logo_url: "" } : f));
      toast.success("Publisher logo uploaded; it is stored locally until Convert to CDN.");
    }).finally(() => {
      if (logoInput.current) logoInput.current.value = "";
    });
  };

  /**
   * `changes` maps a variant to its new focus point, or to null for the automatic crop. The three
   * images are cropped for the outputs below; nothing is uploaded until Convert to CDN.
   */
  const applyFocus = (changes) => {
    if (!card) return;
    void run("focus", async () => {
      const base = cropPreview ? cropPreview.image_focus : (card.image_focus ?? null);
      const merged = Object.fromEntries(
        CARD_VARIANTS.map(({ key }) => [key, key in changes ? changes[key] : focusFor(base, key)]),
      );
      const preview = await api.previewCrop(card.id, merged);
      if (sameFocus(preview.image_focus, card.image_focus ?? null)) {
        setCropPreview(null);
        toast.success("These are the crops the card already has.");
        return;
      }
      setCropPreview(preview);
      toast.success("Crop applied to the outputs below. Click Convert to CDN to upload them.");
    });
  };

  /**
   * Saves the applied crops (if any) and uploads everything still stored locally (the three
   * images and the publisher logo) to the CDN; the outputs then show the CDN links.
   */
  const convertToCdn = () => {
    if (!card) return;
    if (!cropPreview && !cardNeedsCdn(card, config.cdn_provider)) return;
    void run("cdn", async () => {
      const focus = cropPreview?.image_focus;
      const result = await api.convertToCdn(
        card.id,
        !cropPreview
          ? undefined
          : focus
            ? Object.fromEntries(CARD_VARIANTS.map(({ key }) => [key, focusFor(focus, key)]))
            : null,
      );
      setCropPreview(null);
      applyCard(result.card, true);
      if (result.logo_error)
        toast.error(`Images are on the CDN, but the publisher logo could not be uploaded: ${result.logo_error}`);
      else toast.success("Images and logo are on the CDN.");
    });
  };

  const uploadFile = (file) => {
    if (!card || !file) return;
    void run("upload", async () => {
      const updated = await api.uploadThumbnail(card.id, file);
      setCard(updated);
      setForm((f) =>
        f ? { ...f, original_image_url: updated.original_image_url ?? "" } : f,
      );
      toast.success("Thumbnail uploaded; all three sizes are ready locally. Convert to CDN uploads them.");
    }).finally(() => {
      if (fileInput.current) fileInput.current.value = "";
    });
  };

  // Last resort when neither the browser nor the server can download the article image: the
  // editor copies it on the article (right-click → Copy image) and pastes it here.
  useEffect(() => {
    if (!card || ACTIVE_STATUSES.includes(card.status)) return;
    const onPaste = (e) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) =>
        f.type.startsWith("image/"),
      );
      if (!file) return;
      e.preventDefault();
      uploadFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  if (loadError && !card) {
    return (
      <div className="panel">
        <p className="inlineError" role="alert">
          {loadError}
        </p>
        <a className="btn" href="#/library">
          Back to Manage news
        </a>
      </div>
    );
  }
  if (!card || !form)
    return <div className="panel emptyState">Loading card…</div>;

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const imagePending =
    form.original_image_url !== (card.original_image_url ?? "");
  const logoPending =
    form.publisher_logo_url !== (card.publisher_logo_url ?? "");
  // Anything still stored only on this server; Convert to CDN uploads it.
  const needsCdn = !imagePending && !logoPending && cardNeedsCdn(card, config.cdn_provider);
  const previewCard = {
    title: form.title,
    description: form.description,
    publisher: form.publisher,
    published_at: form.published_at
      ? `${form.published_at}T12:00:00.000Z`
      : null,
    canonical_url: form.article_url,
    source_url: card.source_url,
    cdn_image_url: imagePending
      ? null
      : (cropPreview?.variants.large?.url ?? card.cdn_image_url),
    image_variants: imagePending ? {} : (cropPreview?.variants ?? card.image_variants),
    cdn_publisher_logo_url: logoPending ? null : card.cdn_publisher_logo_url,
  };
  const missing = computeMissingFields({ ...previewCard });
  const canApprove =
    APPROVABLE_STATUSES.includes(card.status) &&
    missing.length === 0 &&
    !dirty &&
    !cropPreview &&
    !needsCdn;
  const locked = processing || busy !== null;
  const aspect = `${config.image.width} / ${config.image.height}`;
  const retryCapped =
    card.status === "verification_required" &&
    card.attempts >= MAX_BLOCKED_ATTEMPTS;
  const noPhotoReason = card.warnings.find((w) =>
    w.startsWith("No article photo"),
  );
  const otherWarnings = card.warnings.filter((w) => w !== noPhotoReason);

  return (
    <div className="pageStack">
      <section className="panel">
        <WorkflowSteps card={card} />
      </section>
      <div className="editorLayout">
        <form
          className="panel editorForm"
          onSubmit={save}
          aria-busy={busy === "save"}
        >
          <div className="panelHeader">
            <div>
              <h2>Edit news card</h2>
              <p className="muted">
                <StatusBadge status={card.status} />
                {processing && (
                  <span>
                    {" "}
                    · {STAGE_LABELS[card.processing_stage ?? "queued"]}
                  </span>
                )}
              </p>
            </div>
            <div className="actionsRow">
              <a className="btn btnSmall" href={`#/cards/${card.id}/details`}>
                Details &amp; history
              </a>
              {card.status !== "verification_required" && (
                <a
                  className="btn btnSmall"
                  href={card.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open article ↗
                </a>
              )}
            </div>
          </div>

          {card.status === "verification_required" && (
            <div className="callout calloutWarning" role="status">
              <strong>Verification required.</strong>{" "}
              {card.verification_reason ??
                "The publisher blocked automated access."}
              <details className="bookmarkSetup" open={!bookmarkReady}>
                <summary>
                  {bookmarkReady
                    ? "Bookmark set up ✓ (show setup again)"
                    : "First time only: add the bookmark (10 seconds)"}
                </summary>
                <p>
                  Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> to show
                  your bookmarks bar, then drag this button onto it:{" "}
                  <a
                    ref={setBookmarkletHref}
                    className="btn btnSmall bookmarklet"
                    onClick={(e) => {
                      e.preventDefault();
                      toast.info(
                        "Don't click it here. Drag it to your bookmarks bar.",
                      );
                    }}
                  >
                    Send to News Card Studio
                  </a>
                </p>
              </details>
              <div className="verifySteps">
                <div>
                  <strong>1.</strong>{" "}
                  <button
                    type="button"
                    className="btn btnSmall btnPrimary"
                    onClick={openForVerification}
                  >
                    Open article ↗
                  </button>{" "}
                  and solve the CAPTCHA.
                </div>
                <div>
                  <strong>2.</strong> On the article, click the{" "}
                  <strong>Send to News Card Studio</strong> bookmark. The form
                  below fills in by itself.
                </div>
                <div>
                  <strong>3.</strong> Click <strong>Save draft</strong>.
                </div>
              </div>
              <p className="muted small">
                Form didn't fill in?{" "}
                <button
                  type="button"
                  className="linkButton"
                  onClick={() => void pasteImport()}
                  disabled={locked}
                >
                  Paste page details
                </button>{" "}
                or type the details yourself. Image missing? Right-click it on
                the article, choose <strong>Copy image</strong>, then press{" "}
                <kbd>Ctrl</kbd>+<kbd>V</kbd> here.
              </p>
            </div>
          )}
          {card.status === "duplicate" && card.duplicate_of && (
            <div className="callout calloutInfo">
              This link points to an article that already has a card.{" "}
              <a href={`#/cards/${card.duplicate_of}`}>Open the existing card</a>{" "}
              or delete this one.
            </div>
          )}
          {card.error_message && card.status !== "verification_required" && (
            <div
              className={`callout ${card.status === "failed" ? "calloutError" : "calloutWarning"}`}
              role="status"
            >
              {card.error_message}
            </div>
          )}
          {otherWarnings.length > 0 && (
            <ul className="callout calloutInfo warningList">
              {otherWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <fieldset disabled={locked} className="fieldGrid">
            <label className="field">
              <span>
                Publisher{" "}
                {missing.includes("publisher") && (
                  <em className="req">required</em>
                )}
              </span>
              <input
                value={form.publisher}
                onChange={set("publisher")}
                maxLength={300}
                placeholder="e.g. The Economic Times"
              />
            </label>
            <label className="field">
              <span>
                Publication date{" "}
                {missing.includes("published_at") && (
                  <em className="req">required</em>
                )}
              </span>
              <input
                type="date"
                value={form.published_at}
                onChange={set("published_at")}
              />
            </label>
            <label className="field span2">
              <span>
                Title{" "}
                {missing.includes("title") && <em className="req">required</em>}
                <small className="muted">
                  {" "}
                  · {form.title.length} characters, shown in 2 lines; full text is
                  saved
                </small>
              </span>
              <textarea
                value={form.title}
                onChange={set("title")}
                rows={2}
                maxLength={1000}
              />
            </label>
            <label className="field span2">
              <span>
                Description{" "}
                {missing.includes("description") && (
                  <em className="req">required</em>
                )}
                <small className="muted">
                  {" "}
                  · {form.description.length} characters, shown in 2 lines; full
                  text is saved
                </small>
              </span>
              <textarea
                value={form.description}
                onChange={set("description")}
                rows={4}
                maxLength={10000}
              />
            </label>
            <div className="field span2">
              <span>
                Publisher logo <small className="muted">· optional</small>
              </span>
              <div className="logoRow">
                {card.cdn_publisher_logo_url && !logoPending ? (
                  <img
                    className="logoPreview"
                    src={card.cdn_publisher_logo_url}
                    alt={`${card.publisher ?? "Publisher"} logo`}
                  />
                ) : (
                  <span className="logoPreview logoEmpty muted small">
                    {logoPending
                      ? "Processed on save"
                      : card.publisher_logo_url
                        ? "Not processed"
                        : "None found"}
                  </span>
                )}
                <input
                  type="url"
                  value={form.publisher_logo_url}
                  onChange={set("publisher_logo_url")}
                  className="mono"
                  placeholder="https://…/logo.svg"
                  aria-label="Publisher logo URL"
                />
                <input
                  ref={logoInput}
                  type="file"
                  accept="image/svg+xml,image/png,image/webp,image/jpeg,image/gif"
                  className="srOnly"
                  id={`logo-${card.id}`}
                  onChange={(e) => uploadLogo(e.target.files?.[0])}
                />
                <label
                  htmlFor={`logo-${card.id}`}
                  className={`btn btnSmall ${locked ? "isDisabled" : ""}`}
                >
                  {busy === "logo" ? "Uploading…" : "Upload logo"}
                </label>
              </div>
              {!config.show_publisher_logo && (
                <small className="muted">
                  Stored with the card; not shown on the card (set
                  CARD_SHOW_PUBLISHER_LOGO=true to show it).
                </small>
              )}
            </div>
            <label className="field span2">
              <span>Article URL (Read More link)</span>
              <input
                type="url"
                value={form.article_url}
                onChange={set("article_url")}
                className="mono"
              />
              <small className="muted">
                Original submitted URL: {card.source_url}
              </small>
            </label>
          </fieldset>

          <fieldset disabled={locked} className="thumbSection">
            <legend>
              Thumbnail{" "}
              {missing.includes("image") && <em className="req">required</em>}
            </legend>
            <div className="thumbCurrent">
              {card.cdn_image_url && !imagePending ? (
                <img
                  src={card.cdn_image_url}
                  alt="Current thumbnail"
                  style={{ aspectRatio: aspect }}
                />
              ) : (
                <div className="thumbEmpty" style={{ aspectRatio: aspect }}>
                  {imagePending
                    ? "New image will be processed when you save"
                    : noPhotoReason
                      ? "No article photo found — see the reason below"
                      : "No image yet"}
                </div>
              )}
              <div className="thumbMeta">
                {card.cdn_image_url && (
                  <a
                    href={card.cdn_image_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono truncate"
                  >
                    {card.cdn_image_url}
                  </a>
                )}
                <small className="muted">
                  Outputs ({config.image.format.toUpperCase()}):{" "}
                  {CARD_VARIANTS.map(({ key, label }) => {
                    const size = config.image.variants?.[key];
                    const done = !!card.image_variants?.[key]?.url;
                    return `${label.replace(" card", "")} ${size ? `${size.width}×${size.height}` : ""}${done ? " ✓" : ""}`;
                  }).join(" · ")}
                  {card.cdn_image_source?.startsWith("upload:") &&
                    " · uploaded manually"}
                </small>
                {noPhotoReason && !card.cdn_image_url && (
                  <p className="callout calloutInfo noPhotoReason">
                    {noPhotoReason}
                  </p>
                )}
                {!config.cdn_configured && (
                  <small className="inlineError">
                    The CDN is not configured — images are kept locally until it is.
                  </small>
                )}
              </div>
            </div>

            {card.original_image_url && !imagePending && (
              <FocusPicker
                imageUrl={card.original_image_url}
                focus={cropPreview ? cropPreview.image_focus : card.image_focus}
                variants={cropPreview?.variants ?? card.image_variants}
                sizes={config.image.variants}
                disabled={locked || dirty}
                busy={busy === "focus"}
                onApply={applyFocus}
              />
            )}
            {dirty && card.original_image_url && !imagePending && (
              <small className="muted">Save or discard your edits before changing the focus point.</small>
            )}

            <label className="field">
              <span>Source image URL</span>
              <input
                type="url"
                value={form.original_image_url}
                onChange={set("original_image_url")}
                className="mono"
                placeholder="https://…/image.jpg"
              />
            </label>

            {card.image_candidates.length > 1 && (
              <div
                className="candidateGrid"
                role="radiogroup"
                aria-label="Other images found in the article"
              >
                {card.image_candidates.slice(0, 8).map((url) => (
                  <button
                    type="button"
                    key={url}
                    role="radio"
                    aria-checked={form.original_image_url === url}
                    className={`candidate ${form.original_image_url === url ? "isSelected" : ""}`}
                    onClick={() => setForm({ ...form, original_image_url: url })}
                    title={url}
                  >
                    <img
                      src={url}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  </button>
                ))}
              </div>
            )}

            <div className="actionsRow">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                className="srOnly"
                id={`upload-${card.id}`}
                onChange={(e) => uploadFile(e.target.files?.[0])}
              />

              <label
                htmlFor={`upload-${card.id}`}
                className={`btn btnSmall ${locked ? "isDisabled" : ""}`}
              >
                {busy === "upload" ? "Uploading…" : "Upload image file"}
              </label>
              <small className="muted">
                Only use images you are authorised to publish.
              </small>
            </div>
          </fieldset>

          <div className="actionsRow stickyActions">
            <button
              type="submit"
              className="btn btnPrimary"
              disabled={!dirty || locked}
            >
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
            {dirty && (
              <button
                type="button"
                className="btn"
                onClick={() => setForm(base)}
                disabled={locked}
              >
                Discard changes
              </button>
            )}
            {APPROVABLE_STATUSES.includes(card.status) && (
              <button
                type="button"
                className="btn btnSuccess"
                onClick={approve}
                disabled={!canApprove || locked}
                title={
                  dirty
                    ? "Save your changes first"
                    : cropPreview || needsCdn
                      ? "Click Convert to CDN first; the images are only stored locally"
                      : missing.length
                      ? `Missing: ${missing.map((f) => FIELD_LABELS[f]).join(", ")}`
                      : undefined
                }
              >
                Approve
              </button>
            )}
            {card.status === "approved" && (
              <button
                type="button"
                className="btn btnPrimary"
                onClick={publish}
                disabled={locked || dirty || !!cropPreview || needsCdn}
                title={
                  needsCdn
                    ? "Click Convert to CDN first; the images are only stored locally"
                    : "Shows this approved version on the website"
                }
              >
                {busy === "publish" ? "Saving…" : "Save final changes"}
              </button>
            )}
            {card.live_card && (
              <button
                type="button"
                className="btn"
                onClick={unpublish}
                disabled={locked}
              >
                Remove from website
              </button>
            )}
            {RETRYABLE_STATUSES.includes(card.status) && (
              <button
                type="button"
                className="btn"
                onClick={retry}
                disabled={locked || dirty || retryCapped}
                title={
                  retryCapped
                    ? "The publisher keeps blocking automated access. Complete the card manually."
                    : undefined
                }
              >
                Retry fetching
              </button>
            )}
            {card.status === "queued" && (
              <button
                type="button"
                className="btn"
                onClick={cancel}
                disabled={busy !== null}
              >
                Cancel job
              </button>
            )}
            <button
              type="button"
              className="btn btnDanger pushRight"
              onClick={remove}
              disabled={busy !== null}
            >
              Delete
            </button>
          </div>
          {!canApprove &&
            APPROVABLE_STATUSES.includes(card.status) &&
            missing.length > 0 && (
              <p className="muted small">
                Complete {missing.map((f) => FIELD_LABELS[f]).join(", ")} to
                approve this card.
              </p>
            )}
        </form>

      </div>

      <section className="panel" aria-labelledby="outputs-title">
        <div className="panelHeader">
          <div>
            <h2 id="outputs-title">Card outputs</h2>
            <p className="muted small">
              One article, three placements: the exact website markup with the
              same details and a different image size. Updates live as you edit;
              title and description are clamped to two lines.
            </p>
          </div>
          {(card.original_image_url || needsCdn) && (
            <div className="actionsRow">
              {cropPreview && (
                <button
                  type="button"
                  className="btn btnSmall"
                  onClick={() => setCropPreview(null)}
                  disabled={locked}
                >
                  Discard crops
                </button>
              )}
              <button
                type="button"
                className="btn btnSmall btnPrimary"
                onClick={convertToCdn}
                disabled={(!cropPreview && !needsCdn) || locked || !config.cdn_configured}
                title={
                  !config.cdn_configured
                    ? "The CDN is not configured"
                    : cropPreview || needsCdn
                      ? "Uploads the three images and the publisher logo to the CDN"
                      : "Everything shown is already on the CDN"
                }
              >
                {busy === "cdn" ? "Converting…" : "Convert to CDN"}
              </button>
            </div>
          )}
        </div>
        <CardOutputs card={previewCard} />
      </section>
    </div>
  );
}
