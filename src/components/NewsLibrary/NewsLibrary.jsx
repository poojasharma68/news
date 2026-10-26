import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatPublishDate } from "../../../shared/htmlGenerator.js";
import {
  ACTIVE_STATUSES,
  APPROVABLE_STATUSES,
  computeMissingFields,
  MAX_BLOCKED_ATTEMPTS,
  RETRYABLE_STATUSES,
} from "../../../shared/types.js";
import { api } from "../../lib/api";
import { useAppConfig } from "../../lib/config";
import {
  useDebouncedValue,
  useInterval,
} from "../../lib/hooks";
import { CardOutputs } from "../CardOutputs/CardOutputs";
import { StatusBadge } from "../StatusBadge";
import { useToast } from "../Toast";
import {
  nextStep,
  PUBLISH_CONFIRMATION,
  UNPUBLISH_CONFIRMATION,
} from "../WorkflowSteps/WorkflowSteps";

export const STATUS_FILTERS = [
  { key: "all", label: "All statuses", statuses: [] },
  {
    key: "review",
    label: "Awaiting review",
    statuses: ["completed", "needs_review", "partial_data"],
  },
  {
    key: "verification_required",
    label: "Verification required",
    statuses: ["verification_required"],
  },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "published", label: "Published", statuses: ["published"] },
  {
    key: "processing",
    label: "Processing",
    statuses: ["queued", "processing"],
  },
  {
    key: "failed",
    label: "Failed / cancelled",
    statuses: ["failed", "cancelled"],
  },
  { key: "duplicate", label: "Duplicates", statuses: ["duplicate"] },
];

const PAGE_SIZE = 20;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function initialStatusFilter() {
  const query = window.location.hash.split("?")[1] ?? "";
  const status = new URLSearchParams(query).get("status");
  return STATUS_FILTERS.some((f) => f.key === status) ? status : "all";
}

function canApprove(card) {
  return (
    APPROVABLE_STATUSES.includes(card.status) &&
    computeMissingFields(card).length === 0
  );
}

function canRetry(card) {
  if (!RETRYABLE_STATUSES.includes(card.status)) return false;
  return !(
    card.status === "verification_required" &&
    card.attempts >= MAX_BLOCKED_ATTEMPTS
  );
}

/** Per-article outcome of a bulk action, so nothing fails silently. */
function BulkResults({ results, onDismiss }) {
  const failed = results.items.filter((i) => !i.ok).length;
  return (
    <div
      className={`callout ${failed ? "calloutWarning" : "calloutInfo"} bulkResults`}
      role="status"
    >
      <div className="bulkResultsHeader">
        <strong>
          {results.action}: {results.items.length - failed} done
          {failed ? `, ${failed} not done` : ""}
        </strong>
        <button type="button" className="btn btnSmall btnGhost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <ul>
        {results.items.map((item) => (
          <li key={item.id} className={item.ok ? "resultOk" : "resultFailed"}>
            <span aria-hidden="true">{item.ok ? "✓" : "✕"}</span>{" "}
            <span className="srOnly">{item.ok ? "Done:" : "Not done:"}</span>
            <a href={`#/cards/${item.id}`}>{item.title}</a>
            {!item.ok && <span className="muted"> — {item.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewDialog({ card, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  // Escape is handled via "cancel" (not "close"), so closing during effect cleanup
  // (e.g. StrictMode's double mount) never dismisses the dialog by itself.
  const cancel = (e) => {
    e.preventDefault();
    onClose();
  };
  return (
    <dialog
      ref={ref}
      className="previewDialog"
      onCancel={cancel}
      aria-labelledby="preview-title"
    >
      <div className="panelHeader">
        <div>
          <h2 id="preview-title">{card.title ?? card.source_url}</h2>
          <p className="muted small">
            <StatusBadge status={card.status} /> · {nextStep(card)}
          </p>
        </div>
        <button type="button" className="btn btnSmall" onClick={onClose}>
          Close
        </button>
      </div>
      <CardOutputs card={card} previewHeight={460} />
    </dialog>
  );
}

export function NewsLibrary() {
  const config = useAppConfig();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [statusKey, setStatusKey] = useState(initialStatusFilter);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("created_at");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const [results, setResults] = useState(null);
  const [preview, setPreview] = useState(null);
  // Titles of every card seen, so results can name cards selected on other pages.
  const titles = useRef(new Map());

  const debouncedSearch = useDebouncedValue(search, 300);
  const statuses = useMemo(
    () => STATUS_FILTERS.find((f) => f.key === statusKey)?.statuses ?? [],
    [statusKey],
  );

  useEffect(() => setPage(1), [debouncedSearch, statusKey, from, to, sort]);

  const load = useCallback(async () => {
    try {
      const result = await api.listCards({
        search: debouncedSearch.trim() || undefined,
        status: statuses,
        from: from || undefined,
        to: to || undefined,
        page,
        page_size: PAGE_SIZE,
        sort,
        order: "desc",
      });
      for (const card of result.items)
        titles.current.set(card.id, card.title ?? card.source_url);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statuses, from, to, page, sort]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const items = data?.items ?? [];
  const hasActive = items.some((c) => ACTIVE_STATUSES.includes(c.status));
  useInterval(() => void load(), 4000, hasActive);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const pageIds = items.map((c) => c.id);
  const allOnPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectedIds = [...selected];

  // Selecting only changes local state; processing starts from explicit actions alone.
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    if (allOnPageSelected) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    setSelected(next);
  };

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

  const titleOf = (id) => titles.current.get(id) ?? id;
  const showResults = (action, doneIds, rejected) =>
    setResults({
      action,
      items: [
        ...doneIds.map((id) => ({ id, title: titleOf(id), ok: true })),
        ...rejected.map((r) => ({
          id: r.id,
          title: titleOf(r.id),
          ok: false,
          reason: r.reason,
        })),
      ],
    });

  const approve = (ids) => {
    if (
      ids.length > 1 &&
      !window.confirm(
        `Approve ${plural(ids.length, "article")}?\n\nOnly complete articles are approved. Blocked, failed or incomplete ones are listed with the next step instead.`,
      )
    )
      return;
    void run("approve", async () => {
      const result = await api.approve(ids);
      showResults(
        "Approve",
        result.approved.map((c) => c.id),
        result.rejected,
      );
      await load();
    });
  };

  const retry = (ids) => {
    if (
      ids.length > 1 &&
      !window.confirm(
        `Retry fetching ${plural(ids.length, "article")}?\n\nArticles that are complete, still processing, or repeatedly blocked by a CAPTCHA are skipped.`,
      )
    )
      return;
    void run("retry", async () => {
      const result = await api.retryCards(ids);
      showResults(
        "Retry",
        result.retried.map((c) => c.id),
        result.rejected,
      );
      await load();
    });
  };

  const publishSelected = () => {
    if (!window.confirm(PUBLISH_CONFIRMATION)) return;
    void run("publish", async () => {
      const result = await api.publish(selectedIds);
      showResults(
        "Save final changes",
        result.published.map((c) => c.id),
        result.rejected,
      );
      await load();
    });
  };

  const unpublishSelected = () => {
    if (!window.confirm(UNPUBLISH_CONFIRMATION)) return;
    void run("unpublish", async () => {
      const result = await api.unpublish(selectedIds);
      showResults(
        "Remove from website",
        result.removed.map((c) => c.id),
        result.rejected,
      );
      await load();
    });
  };

  const remove = (id, title) => {
    if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    void run(`delete-${id}`, async () => {
      await api.deleteCard(id);
      const next = new Set(selected);
      next.delete(id);
      setSelected(next);
      toast.success("Card deleted.");
      await load();
    });
  };

  const resetFilters = () => {
    setSearch("");
    setStatusKey("all");
    setFrom("");
    setTo("");
  };

  return (
    <section className="panel" aria-labelledby="library-title">
      <div className="panelHeader">
        <div>
          <h2 id="library-title">Manage news</h2>
          <p className="muted">
            {data ? plural(data.total, "article") : "Loading…"}
          </p>
        </div>
        <a className="btn btnSmall btnPrimary" href="#/">
          Add articles
        </a>
      </div>

      <div className="filterBar">
        <label className="field grow">
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Title or publisher"
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={statusKey}
            onChange={(e) => setStatusKey(e.target.value)}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Published from</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Published to</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="created_at">Recently added</option>
            <option value="published_at">Publication date</option>
            <option value="updated_at">Recently updated</option>
          </select>
        </label>
      </div>

      {selected.size > 0 && (
        <div className="bulkBar" role="toolbar" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          <button
            type="button"
            className="btn btnSmall btnSuccess"
            onClick={() => approve(selectedIds)}
            disabled={busy !== null}
          >
            {busy === "approve" ? "Approving…" : "Approve selected"}
          </button>
          <button
            type="button"
            className="btn btnSmall"
            onClick={() => retry(selectedIds)}
            disabled={busy !== null}
          >
            {busy === "retry" ? "Retrying…" : "Retry selected"}
          </button>
          <button
            type="button"
            className="btn btnSmall btnPrimary"
            onClick={publishSelected}
            disabled={busy !== null}
            title="Shows the approved version of the selected cards on the website"
          >
            {busy === "publish" ? "Saving…" : "Save final changes"}
          </button>
          <button
            type="button"
            className="btn btnSmall"
            onClick={unpublishSelected}
            disabled={busy !== null}
          >
            Remove from website
          </button>
          <button
            type="button"
            className="btn btnSmall btnGhost pushRight"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
          <small className="muted fullWidth">
            Only approved cards can be saved to the website. Selection on other
            pages is kept.
          </small>
        </div>
      )}

      {results && (
        <BulkResults results={results} onDismiss={() => setResults(null)} />
      )}

      {error && (
        <p className="inlineError" role="alert">
          {error}{" "}
          <button
            type="button"
            className="btn btnSmall"
            onClick={() => void load()}
          >
            Retry
          </button>
        </p>
      )}

      {loading && !data && <p className="emptyState">Loading articles…</p>}
      {data && items.length === 0 && (
        <div className="emptyState">
          {data.total === 0 && statusKey === "all" && !debouncedSearch ? (
            <>
              <p>No articles yet.</p>
              <a className="btn btnSmall btnPrimary" href="#/">
                Add article URLs
              </a>
            </>
          ) : (
            <>
              <p>No articles match these filters.</p>
              <button
                type="button"
                className="btn btnSmall"
                onClick={resetFilters}
              >
                Reset filters
              </button>
            </>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="tableWrap">
          <table className="libraryTable">
            <thead>
              <tr>
                <th scope="col" className="colCheck">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAll}
                    aria-label="Select all articles on this page"
                  />
                </th>
                <th scope="col" className="colThumb">
                  <span className="srOnly">Thumbnail</span>
                </th>
                <th scope="col">Article</th>
                <th scope="col">Publisher</th>
                <th scope="col">Published</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="srOnly">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((card) => {
                const title = card.title ?? card.source_url;
                const showError =
                  card.error_message || card.status === "verification_required";
                return (
                  <tr
                    key={card.id}
                    className={selected.has(card.id) ? "isSelected" : ""}
                  >
                    <td className="colCheck">
                      <input
                        type="checkbox"
                        checked={selected.has(card.id)}
                        onChange={() => toggle(card.id)}
                        aria-label={`Select ${title}`}
                      />
                    </td>
                    <td className="colThumb">
                      {card.cdn_image_url ? (
                        <img src={card.cdn_image_url} alt="" loading="lazy" />
                      ) : (
                        <span className="thumbPlaceholder" aria-hidden="true" />
                      )}
                    </td>
                    <td className="colArticle">
                      <a href={`#/cards/${card.id}`} className="rowTitle">
                        {title}
                      </a>
                      <span className="muted mono truncate">
                        {card.canonical_url ?? card.source_url}
                      </span>
                      <span className="nextStep small">{nextStep(card)}</span>
                    </td>
                    <td>
                      <span className="publisherCell">
                        {card.cdn_publisher_logo_url && (
                          <img
                            className="publisherCellLogo"
                            src={card.cdn_publisher_logo_url}
                            alt=""
                            loading="lazy"
                          />
                        )}
                        {card.publisher ?? <span className="muted">—</span>}
                      </span>
                    </td>
                    <td className="nowrap">
                      {card.published_at ? (
                        formatPublishDate(card.published_at, config.date_format)
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="colStatus">
                      <StatusBadge status={card.status} />
                      {showError && (
                        <span
                          className="rowError small"
                          title={card.verification_reason ?? card.error_message}
                        >
                          {card.status === "verification_required"
                            ? (card.verification_reason ??
                              "The publisher blocked automated access.")
                            : card.error_message}
                        </span>
                      )}
                    </td>
                    <td className="colActions">
                      <button
                        type="button"
                        className="btn btnSmall"
                        onClick={() => setPreview(card)}
                      >
                        Preview
                      </button>
                      {canApprove(card) && (
                        <button
                          type="button"
                          className="btn btnSmall btnSuccess"
                          onClick={() => approve([card.id])}
                          disabled={busy !== null}
                        >
                          Approve
                        </button>
                      )}
                      {canRetry(card) && (
                        <button
                          type="button"
                          className="btn btnSmall"
                          onClick={() => retry([card.id])}
                          disabled={busy !== null}
                        >
                          Retry
                        </button>
                      )}
                      <a className="btn btnSmall" href={`#/cards/${card.id}`}>
                        Edit
                      </a>
                      <button
                        type="button"
                        className="btn btnSmall btnDangerGhost"
                        onClick={() => remove(card.id, title)}
                        disabled={busy !== null}
                        aria-label={`Delete ${title}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <nav className="pagination" aria-label="Pagination">
          <button
            type="button"
            className="btn btnSmall"
            onClick={() => setPage(page - 1)}
            disabled={page <= 1}
          >
            ← Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btnSmall"
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
          >
            Next →
          </button>
        </nav>
      )}

      {preview && (
        <PreviewDialog card={preview} onClose={() => setPreview(null)} />
      )}
    </section>
  );
}
