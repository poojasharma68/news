import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIVE_STATUSES,
  FIELD_LABELS,
  PROCESSING_STAGES,
  RETRYABLE_STATUSES,
  STAGE_LABELS,
} from "../../../shared/types.js";
import { api } from "../../lib/api";
import { useInterval } from "../../lib/hooks";
import { StatusBadge } from "../StatusBadge";
import { useToast } from "../Toast";

const STAGE_COUNT = PROCESSING_STAGES.length - 1;

function stageProgress(card) {
  if (!ACTIVE_STATUSES.includes(card.status)) return 100;
  const index = PROCESSING_STAGES.indexOf(card.processing_stage ?? "queued");
  return Math.max(4, Math.round((Math.max(index, 0) / STAGE_COUNT) * 100));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function cardMessage(card) {
  if (card.status === "verification_required") {
    return {
      tone: "warning",
      text: `${card.verification_reason ?? "The publisher blocked automated access."} Open the article and complete the card manually.`,
    };
  }
  if (card.error_message)
    return {
      tone: card.status === "failed" ? "error" : "warning",
      text: card.error_message,
    };
  if (card.status === "partial_data" && card.missing_fields.length) {
    return {
      tone: "warning",
      text: `Missing: ${card.missing_fields.map((f) => FIELD_LABELS[f]).join(", ")}.`,
    };
  }
  if (card.warnings.length) return { tone: "info", text: card.warnings[0] };
  return null;
}

export function ProcessingQueue({
  batchId,
  refreshKey,
  onSelectBatch,
  onActivityChange,
}) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const wasActive = useRef(false);

  const loadBatches = useCallback(async () => {
    try {
      setBatches((await api.listBatches(10)).items);
    } catch {
      /* non-critical */
    }
  }, []);

  const load = useCallback(async () => {
    if (!batchId) {
      setDetail(null);
      return;
    }
    try {
      const next = await api.getBatch(batchId);
      setDetail(next);
      setError(null);
      const active = next.progress.active > 0;
      if (wasActive.current && !active) onActivityChange();
      wasActive.current = active;
    } catch (err) {
      setError(err.message);
    }
  }, [batchId, onActivityChange]);

  useEffect(() => {
    setLoading(true);
    void Promise.all([load(), loadBatches()]).finally(() => setLoading(false));
  }, [load, loadBatches, refreshKey]);

  const active = (detail?.progress.active ?? 0) > 0;
  useInterval(() => void load(), 2000, active);

  const run = async (key, action, success) => {
    setBusy(key);
    try {
      await action();
      toast.success(success);
      await load();
      onActivityChange();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const cards = detail?.cards ?? [];
  const retryable = cards.filter(
    (c) => c.status === "failed" || c.status === "cancelled",
  ).length;
  const queued = cards.filter((c) => c.status === "queued").length;
  const percent =
    detail && detail.progress.total
      ? Math.round((detail.progress.finished / detail.progress.total) * 100)
      : 0;

  return (
    <section className="panel" aria-labelledby="queue-title">
      <div className="panelHeader">
        <div>
          <h2 id="queue-title">Processing queue</h2>
          <p className="muted">
            Each article is processed independently. Failures never stop the
            rest of the batch.
          </p>
        </div>
        {batches.length > 0 && (
          <label className="field compact">
            <span>Batch</span>
            <select
              value={batchId ?? ""}
              onChange={(e) => onSelectBatch(e.target.value || null)}
            >
              {!batchId && <option value="">Select a batch…</option>}
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {new Date(b.created_at).toLocaleString()} ·{" "}
                  {b.submitted_count} URL{b.submitted_count === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!batchId && (
        <p className="emptyState">
          No batch yet. Paste article links above and choose “Fetch All News”.
        </p>
      )}
      {batchId && loading && !detail && (
        <p className="emptyState">Loading batch…</p>
      )}
      {error && (
        <p className="inlineError" role="alert">
          {error}
        </p>
      )}

      {detail && (
        <>
          <div className="batchProgress">
            <div className="progressLabel">
              <span>
                {detail.progress.finished} of {detail.progress.total} finished
                {active && ` · ${detail.progress.active} in progress`}
              </span>
              <span>{percent}%</span>
            </div>
            <div
              className="progressTrack"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Batch progress"
            >
              <div className="progressFill" style={{ width: `${percent}%` }} />
            </div>
            <div className="actionsRow">
              <button
                type="button"
                className="btn btnSmall"
                disabled={!retryable || busy !== null}
                onClick={() =>
                  void run(
                    "retry-all",
                    () => api.retryBatch(detail.id),
                    "Eligible failed jobs were re-queued.",
                  )
                }
              >
                Retry eligible failed ({retryable})
              </button>
              <button
                type="button"
                className="btn btnSmall"
                disabled={!queued || busy !== null}
                onClick={() =>
                  void run(
                    "cancel-all",
                    () => api.cancelBatch(detail.id),
                    "Queued jobs were cancelled.",
                  )
                }
              >
                Cancel queued ({queued})
              </button>
            </div>
          </div>

          {cards.length === 0 && (
            <p className="emptyState">
              This batch has no new articles — every link was skipped.
            </p>
          )}

          <ul className="queueList">
            {cards.map((card) => {
              const message = cardMessage(card);
              const thumb = card.cdn_image_url ?? card.original_image_url;
              const isActive = ACTIVE_STATUSES.includes(card.status);
              return (
                <li key={card.id} className="queueItem">
                  <div className="queueThumb">
                    {thumb ? (
                      <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span aria-hidden="true">📰</span>
                    )}
                  </div>
                  <div className="queueBody">
                    <div className="queueTop">
                      <span className="queuePublisher">
                        {card.publisher ?? hostOf(card.source_url)}
                      </span>
                      <StatusBadge status={card.status} />
                    </div>
                    <a className="queueTitle" href={`#/cards/${card.id}`}>
                      {card.title ?? card.source_url}
                    </a>
                    <a
                      className="queueUrl mono"
                      href={card.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {card.source_url}
                    </a>
                    {isActive && (
                      <div className="stageRow" aria-live="polite">
                        <div className="progressTrack small">
                          <div
                            className="progressFill"
                            style={{ width: `${stageProgress(card)}%` }}
                          />
                        </div>
                        <span className="muted">
                          {STAGE_LABELS[card.processing_stage ?? "queued"]}
                        </span>
                      </div>
                    )}
                    {message && (
                      <p className={`queueMessage tone-${message.tone}`}>
                        {message.text}
                      </p>
                    )}
                  </div>
                  <div className="queueActions">
                    {RETRYABLE_STATUSES.includes(card.status) && (
                      <button
                        type="button"
                        className="btn btnSmall"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            card.id,
                            () => api.retryCard(card.id),
                            "Job re-queued.",
                          )
                        }
                      >
                        Retry
                      </button>
                    )}
                    {card.status === "queued" && (
                      <button
                        type="button"
                        className="btn btnSmall"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            card.id,
                            () => api.cancelCard(card.id),
                            "Job cancelled.",
                          )
                        }
                      >
                        Cancel
                      </button>
                    )}
                    {!isActive && (
                      <a
                        className="btn btnSmall btnPrimary"
                        href={`#/cards/${card.id}`}
                      >
                        {card.status === "verification_required" ||
                        card.status === "partial_data"
                          ? "Complete"
                          : "Review"}
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {detail.skipped.length > 0 && (
            <details className="skippedList">
              <summary>
                {detail.skipped.length} link
                {detail.skipped.length === 1 ? " was" : "s were"} skipped
              </summary>
              <ul>
                {detail.skipped.map((s, i) => (
                  <li key={`${s.url}-${i}`}>
                    <span className="mono truncate">{s.url}</span> — {s.message}{" "}
                    {s.card_id && (
                      <a href={`#/cards/${s.card_id}`}>Open existing card</a>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
