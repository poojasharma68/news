import { useId, useMemo, useState } from "react";
import { parseUrlList, uniqueValidUrls } from "../../../shared/urlUtils.js";
import { useStoredState } from "../../lib/hooks";

export function BulkUrlInput({ maxBatchSize, onSubmit }) {
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useStoredState("mu.bulkUrlDraft", "");
  const [reviewFirst, setReviewFirst] = useStoredState(
    "mu.reviewBeforeProcessing",
    true,
  );
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const entries = useMemo(() => parseUrlList(text), [text]);
  const validUrls = useMemo(() => uniqueValidUrls(entries), [entries]);
  const invalid = entries.filter((e) => e.error);
  const duplicates = entries.filter((e) => e.duplicateOf !== null);
  const overLimit = validUrls.length > maxBatchSize;
  const canSubmit = validUrls.length > 0 && !overLimit && !submitting;

  const submit = async () => {
    setSubmitting(true);
    try {
      if (await onSubmit(validUrls)) {
        setText("");
        setReviewing(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleFetch = () => {
    if (!canSubmit) return;
    if (reviewFirst && !reviewing) setReviewing(true);
    else void submit();
  };

  const clearAll = () => {
    setText("");
    setReviewing(false);
  };

  return (
    <section className="panel" aria-labelledby={`${inputId}-title`}>
      <div className="panelHeader">
        <div>
          <h2 id={`${inputId}-title`}>Add news articles</h2>
          <p className="muted">
            Paste one article URL per line. Links copied from Google Sheets or
            Excel work too.
          </p>
        </div>
      </div>

      {!reviewing ? (
        <>
          <label htmlFor={inputId} className="srOnly">
            Article URLs, one per line
          </label>
          <textarea
            id={inputId}
            className="urlTextarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "https://www.publisher.com/news/article-one\nhttps://www.another-publisher.com/article-two"
            }
            spellCheck={false}
            rows={9}
            aria-describedby={hintId}
            disabled={submitting}
          />

          <div id={hintId} className="urlCounts" aria-live="polite">
            <span>
              <strong>{entries.length}</strong> detected
            </span>
            <span className="countValid">
              <strong>{validUrls.length}</strong> ready
            </span>
            {invalid.length > 0 && (
              <span className="countInvalid">
                <strong>{invalid.length}</strong> invalid
              </span>
            )}
            {duplicates.length > 0 && (
              <span className="countDuplicate">
                <strong>{duplicates.length}</strong> duplicate
                {duplicates.length === 1 ? "" : "s"} (will be skipped)
              </span>
            )}
            <span className="muted">Limit: {maxBatchSize} per batch</span>
          </div>

          {overLimit && (
            <p className="inlineError" role="alert">
              {validUrls.length} unique URLs found. Split them into batches of
              at most {maxBatchSize}.
            </p>
          )}

          {invalid.length > 0 && (
            <ul className="invalidList" aria-label="Invalid links">
              {invalid.slice(0, 6).map((entry) => (
                <li key={entry.index}>
                  <span className="mono">#{entry.index}</span>{" "}
                  <span className="truncate mono">{entry.raw}</span> —{" "}
                  {entry.error}
                </li>
              ))}
              {invalid.length > 6 && (
                <li className="muted">…and {invalid.length - 6} more</li>
              )}
            </ul>
          )}

          <div className="actionsRow">
            <button
              type="button"
              className="btn btnPrimary"
              onClick={handleFetch}
              disabled={!canSubmit}
            >
              {submitting
                ? "Submitting…"
                : reviewFirst
                  ? `Review ${validUrls.length || ""} URLs`
                  : "Fetch All News"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={clearAll}
              disabled={!text || submitting}
            >
              Clear All
            </button>
            {(invalid.length > 0 || duplicates.length > 0) && (
              <button
                type="button"
                className="btn btnGhost"
                onClick={() => setText(validUrls.join("\n"))}
                disabled={submitting}
              >
                Remove invalid &amp; duplicates
              </button>
            )}
            <label className="checkbox pushRight">
              <input
                type="checkbox"
                checked={reviewFirst}
                onChange={(e) => setReviewFirst(e.target.checked)}
              />
              Review URLs before processing
            </label>
          </div>
        </>
      ) : (
        <div className="reviewPanel">
          <p>
            <strong>{validUrls.length}</strong> article
            {validUrls.length === 1 ? "" : "s"} will be processed.
            {invalid.length + duplicates.length > 0 &&
              ` ${invalid.length + duplicates.length} entries will be skipped.`}
          </p>
          <ol className="reviewList">
            {entries.map((entry) => (
              <li
                key={entry.index}
                className={
                  entry.error
                    ? "isInvalid"
                    : entry.duplicateOf
                      ? "isDuplicate"
                      : ""
                }
              >
                <span className="reviewUrl mono">{entry.url ?? entry.raw}</span>
                <span className="reviewState">
                  {entry.error
                    ? `Invalid: ${entry.error}`
                    : entry.duplicateOf
                      ? `Duplicate of #${entry.duplicateOf}`
                      : "Ready"}
                </span>
              </li>
            ))}
          </ol>
          <div className="actionsRow">
            <button
              type="button"
              className="btn btnPrimary"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {submitting ? "Submitting…" : "Fetch All News"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setReviewing(false)}
              disabled={submitting}
            >
              Back to editing
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
