/**
 * Card activity log (`news_card_events`). Events record what happened to an article, when, by
 * whom and in which job (correlation id), so editors can see the history behind a status.
 */

/** Records an event. Never throws: a logging failure must not break processing or an edit. */
export async function recordEvent(deps, cardId, event, details = {}) {
  try {
    await deps.repo.addEvent({
      card_id: cardId,
      event,
      status: details.status ?? null,
      message: details.message ?? null,
      actor: details.actor ?? null,
      correlation_id: details.correlationId ?? null,
    });
  } catch (err) {
    deps.logger.warn("Could not record card event", {
      cardId,
      event,
      error: err,
    });
  }
}
