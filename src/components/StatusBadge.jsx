import { STATUS_LABELS } from "../../shared/types.js";

export function StatusBadge({ status }) {
  return (
    <span className={`badge badge-${status}`}>
      {(status === "processing" || status === "queued") && (
        <span className="badgeDot" aria-hidden="true" />
      )}
      {STATUS_LABELS[status]}
    </span>
  );
}
