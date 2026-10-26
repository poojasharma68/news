import {
  ACTIVE_STATUSES,
  APPROVABLE_STATUSES,
  computeMissingFields,
  FIELD_LABELS,
} from "../../../shared/types.js";

/** Shown before an editor sends approved cards to the website. */
export const PUBLISH_CONFIRMATION =
  "Save the final changes and show this version on the website?\n\nPages that use the news API show it within about a minute.";

export const UNPUBLISH_CONFIRMATION =
  "Remove from the website?\n\nThe card is kept here and can be saved to the website again later.";

/**
 * The three separate gates every article passes, derived from its status:
 *   1. Fetch    — automatic extraction, or manual completion when a publisher blocks access
 *   2. Content  — an editor reviews the data and the three outputs, then approves
 *   3. Publish  — "Save final changes" puts the approved version on the website (public API)
 */
export function workflowSteps(card) {
  const active = ACTIVE_STATUSES.includes(card.status);
  const approved = card.status === "approved" || card.status === "published";
  const missing = computeMissingFields(card);

  let fetch = { state: "done", detail: "Metadata and images are in." };
  if (active) fetch = { state: "current", detail: "Fetching and processing…" };
  else if (card.status === "verification_required")
    fetch = {
      state: "blocked",
      detail: "Blocked by CAPTCHA or bot protection. Complete the card manually.",
    };
  else if (card.status === "failed" || card.status === "cancelled")
    fetch = { state: "blocked", detail: "Did not finish. Retry or complete it manually." };
  else if (card.status === "duplicate")
    fetch = { state: "blocked", detail: "Duplicate of another card." };

  let content = { state: "pending", detail: "Waiting for the fetch step." };
  if (approved)
    content = {
      state: "done",
      detail: card.approved_by ? `Approved by ${card.approved_by}.` : "Approved.",
    };
  else if (APPROVABLE_STATUSES.includes(card.status) || card.status === "verification_required")
    content = missing.length
      ? {
          state: "current",
          detail: `Complete: ${missing.map((f) => FIELD_LABELS[f]).join(", ")}.`,
        }
      : { state: "current", detail: "Review the three outputs and approve." };

  let publish = {
    state: "pending",
    detail: card.live_card
      ? "The website shows the last saved version. Approve, then save the final changes to update it."
      : "Waiting for approval.",
  };
  if (card.status === "published")
    publish = { state: "done", detail: "Live on the website." };
  else if (card.status === "approved")
    publish = {
      state: "current",
      detail: card.live_card
        ? "Save the final changes to update the website."
        : "Save the final changes to put it on the website.",
    };

  return [
    { key: "fetch", label: "Fetch", ...fetch },
    { key: "content", label: "Content approval", ...content },
    { key: "publish", label: "Publish", ...publish },
  ];
}

/** One-line "what happens next" for list views. */
export function nextStep(card) {
  const step = workflowSteps(card).find((s) => s.state !== "done");
  return step ? step.detail : "Live on the website.";
}

export function WorkflowSteps({ card }) {
  return (
    <ol className="workflowSteps" aria-label="Workflow">
      {workflowSteps(card).map((step, index) => (
        <li key={step.key} className={`workflowStep step-${step.state}`}>
          <span className="stepIndex" aria-hidden="true">
            {step.state === "done" ? "✓" : step.state === "blocked" ? "!" : index + 1}
          </span>
          <span className="stepBody">
            <strong>{step.label}</strong>
            <span className="muted small">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
