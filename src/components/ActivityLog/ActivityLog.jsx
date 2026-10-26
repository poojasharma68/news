import { useEffect, useState } from "react";
import { STATUS_LABELS } from "../../../shared/types.js";
import { api } from "../../lib/api";

const EVENT_LABELS = {
  submitted: "Added",
  job_started: "Processing started",
  extracted: "Metadata extracted",
  blocked: "Blocked by publisher",
  duplicate: "Marked as duplicate",
  images_uploaded: "Images uploaded to the CDN",
  job_finished: "Processing finished",
  retry_scheduled: "Retry scheduled",
  job_failed: "Processing failed",
  requeued: "Queued again",
  cancelled: "Cancelled",
  edited: "Edited",
  thumbnail_uploaded: "Thumbnail uploaded",
  logo_uploaded: "Logo uploaded",
  approved: "Approved",
  published_confirmed: "Final changes saved (live on the website)",
  unpublished: "Removed from the website",
};

/** The card's processing history. Reloads when `version` (the card's updated_at) changes. */
export function ActivityLog({ cardId, version }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getCardEvents(cardId).then(
      (result) => {
        if (cancelled) return;
        setEvents(result.items);
        setError(null);
      },
      (err) => !cancelled && setError(err.message),
    );
    return () => {
      cancelled = true;
    };
  }, [cardId, version]);

  if (error) return <p className="inlineError">{error}</p>;
  if (!events) return <p className="muted small">Loading history…</p>;
  if (!events.length) return <p className="muted small">No events recorded yet.</p>;

  return (
    <ol className="activityLog">
      {events.map((e) => (
        <li key={e.id}>
          <span className="activityWhen muted small">
            {new Date(e.created_at).toLocaleString()}
          </span>
          <span>
            <strong>{EVENT_LABELS[e.event] ?? e.event}</strong>
            {e.status && ` · ${STATUS_LABELS[e.status] ?? e.status}`}
            {e.actor && <span className="muted"> · {e.actor}</span>}
          </span>
          {e.message && <span className="muted small">{e.message}</span>}
          {e.correlation_id && (
            <span className="muted small mono" title="Job id">
              job {e.correlation_id.slice(0, 8)}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
