import { useEffect, useState } from "react";
import { FIELD_LABELS } from "../../../shared/types.js";
import { ActivityLog } from "../../components/ActivityLog/ActivityLog";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";

const METHOD_LABELS = {
  metadata: "Page metadata",
  browser: "Browser rendering",
  api: "Publisher API",
  rss: "RSS feed",
  manual: "Manual entry",
};

/** A card's processing details and history, kept apart from the editor. */
export function CardDetailsPage({ id }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    api.getCard(id).then(
      (loaded) => active && setCard(loaded),
      (err) => active && setError(err.message),
    );
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <div className="pageStack">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <a href="#/library">Manage news</a> <span aria-hidden="true">/</span>{" "}
        <a href={`#/cards/${id}`}>Card</a> <span aria-hidden="true">/</span>{" "}
        <span>Details &amp; history</span>
      </nav>
      {error && !card ? (
        <div className="panel">
          <p className="inlineError" role="alert">
            {error}
          </p>
        </div>
      ) : !card ? (
        <div className="panel emptyState">Loading card…</div>
      ) : (
        <div className="detailsLayout">
          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>Details</h2>
                <p className="muted truncate">{card.title ?? card.source_url}</p>
              </div>
              <StatusBadge status={card.status} />
            </div>
            <dl className="detailList">
              <dt>Extraction</dt>
              <dd>{card.extraction_method ? METHOD_LABELS[card.extraction_method] : "—"}</dd>
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
        </div>
      )}
    </div>
  );
}
