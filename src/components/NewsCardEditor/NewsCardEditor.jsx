import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toDateInputValue } from "../../../shared/htmlGenerator.js";
import {
  ACTIVE_STATUSES,
  APPROVABLE_STATUSES,
  CARD_VARIANTS,
  computeMissingFields,
  FIELD_LABELS,
  MAX_BLOCKED_ATTEMPTS,
  RETRYABLE_STATUSES,
  STAGE_LABELS,
} from "../../../shared/types.js";
import { api } from "../../lib/api";
import { useAppConfig } from "../../lib/config";
import { navigate, useInterval } from "../../lib/hooks";
import { ActivityLog } from "../ActivityLog/ActivityLog";
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

const METHOD_LABELS = {
  metadata: "Page metadata",
  browser: "Browser rendering",
  api: "Publisher API",
  rss: "RSS feed",
  manual: "Manual entry",
};

export function NewsCardEditor({ cardId }) {
  const config = useAppConfig();
  const toast = useToast();
  const tz = config.date_format.timeZone;
  const [card, setCard] = useState(null);
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
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

  const processing = !!card && ACTIVE_STATUSES.includes(card.status);
  // While processing, keep refreshing; the form is reset only if the user has not edited it.
  useInterval(() => void load(!dirty), 2000, processing);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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

  const uploadLogo = (file) => {
    if (!card || !file) return;
    void run("logo", async () => {
      const updated = await api.uploadLogo(card.id, file);
      setCard(updated);
      setForm((f) => (f ? { ...f, publisher_logo_url: "" } : f));
      toast.success("Publisher logo uploaded to the CDN.");
    }).finally(() => {
      if (logoInput.current) logoInput.current.value = "";
    });
  };

  /** `changes` maps a variant to its new focus point, or to null for the automatic crop. */
  const applyFocus = (changes) => {
    if (!card) return;
    void run("focus", async () => {
      const updated = await api.updateCard(card.id, { image_focus: changes });
      applyCard(updated, true);
      toast.success("Crop saved. Re-creating the changed images…");
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
      toast.success("Thumbnail uploaded; all three sizes are on the CDN.");
    }).finally(() => {
      if (fileInput.current) fileInput.current.value = "";
    });
  };

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
  const previewCard = {
    title: form.title,
    description: form.description,
    publisher: form.publisher,
    published_at: form.published_at
      ? `${form.published_at}T12:00:00.000Z`
      : null,
    canonical_url: form.article_url,
    source_url: card.source_url,
    cdn_image_url: imagePending ? null : card.cdn_image_url,
    image_variants: imagePending ? {} : card.image_variants,
    cdn_publisher_logo_url: logoPending ? null : card.cdn_publisher_logo_url,
  };
  const missing = computeMissingFields({ ...previewCard });
  const canApprove =
    APPROVABLE_STATUSES.includes(card.status) && missing.length === 0 && !dirty;
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
            <a
              className="btn btnSmall"
              href={card.source_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open article ↗
            </a>
          </div>

          {card.status === "verification_required" && (
            <div className="callout calloutWarning" role="status">
              <strong>Verification required.</strong>{" "}
              {card.verification_reason ??
                "The publisher blocked automated access."}
              <p>
                Approving or retrying does not get past a CAPTCHA, and this tool
                never tries to.
              </p>
              <ol>
                <li>
                  Open the article in your browser (button above) and complete any
                  check yourself.
                </li>
                <li>Copy the missing details into the fields below.</li>
                <li>
                  Paste the article's image address, or upload the image file.
                </li>
                <li>
                  Save — processing resumes automatically for the thumbnail.
                </li>
              </ol>
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
                  alt="Current CDN thumbnail"
                  style={{ aspectRatio: aspect }}
                />
              ) : (
                <div className="thumbEmpty" style={{ aspectRatio: aspect }}>
                  {imagePending
                    ? "New image will be processed when you save"
                    : noPhotoReason
                      ? "No article photo found — see the reason below"
                      : "No CDN image yet"}
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
                    The CDN is not configured — thumbnails cannot be uploaded yet.
                  </small>
                )}
              </div>
            </div>

            {card.original_image_url && !imagePending && (
              <FocusPicker
                imageUrl={card.original_image_url}
                focus={card.image_focus}
                variants={card.image_variants}
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
                disabled={locked || dirty}
                title="Shows this approved version on the website"
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

        <aside className="editorSide">
          <section className="panel">
            <h2>Details</h2>
            <dl className="detailList">
              <dt>Extraction</dt>
              <dd>
                {card.extraction_method
                  ? METHOD_LABELS[card.extraction_method]
                  : "—"}
              </dd>
              <dt>Missing</dt>
              <dd>
                {card.missing_fields.length
                  ? card.missing_fields.map((f) => FIELD_LABELS[f]).join(", ")
                  : "Nothing"}
              </dd>
              <dt>Original image</dt>
              <dd className="truncate mono">{card.original_image_url ?? "—"}</dd>
              <dt>Attempts</dt>
              <dd>{card.attempts}</dd>
              <dt>Created</dt>
              <dd>{new Date(card.created_at).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd>{new Date(card.updated_at).toLocaleString()}</dd>
              {card.approved_at && (
                <>
                  <dt>Approved</dt>
                  <dd>
                    {new Date(card.approved_at).toLocaleString()}
                    {card.approved_by && ` by ${card.approved_by}`}
                  </dd>
                </>
              )}
              <dt>Website</dt>
              <dd>
                {card.live_card && card.site_published_at
                  ? `Live since ${new Date(card.site_published_at).toLocaleString()}${
                      card.status === "published" ? "" : " (older version; save again to update)"
                    }`
                  : "Not on the website"}
              </dd>
              {card.live_card && (
                <>
                  <dt>Website API</dt>
                  <dd className="truncate mono">
                    <a href={`/api/public/news/${card.id}`} target="_blank" rel="noreferrer">
                      /api/public/news/{card.id}
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </section>

          <section className="panel">
            <h2>History</h2>
            <ActivityLog cardId={card.id} version={card.updated_at} />
          </section>
        </aside>
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
        </div>
        <CardOutputs card={previewCard} />
      </section>
    </div>
  );
}
