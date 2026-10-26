const TILES = [
  {
    label: "Total news cards",
    statuses: "total",
    hint: "All cards in the library",
  },
  {
    label: "Processing",
    statuses: ["queued", "processing"],
    hint: "Queued or running jobs",
    filter: "processing",
    tone: "info",
  },
  {
    label: "Completed",
    statuses: ["approved", "published"],
    hint: "Approved or published",
    filter: "approved",
    tone: "success",
  },
  {
    label: "Awaiting review",
    statuses: ["completed", "needs_review", "partial_data"],
    hint: "Ready, flagged or partial",
    filter: "review",
    tone: "review",
  },
  {
    label: "Verification required",
    statuses: ["verification_required"],
    hint: "Blocked by CAPTCHA / bot checks",
    filter: "verification_required",
    tone: "warning",
  },
  {
    label: "Failed jobs",
    statuses: ["failed"],
    hint: "Need a retry or a fix",
    filter: "failed",
    tone: "danger",
  },
];

export function StatsOverview({ stats, loading }) {
  return (
    <section className="statsGrid" aria-label="Overview" aria-busy={loading}>
      {TILES.map((tile) => {
        const value = !stats
          ? null
          : tile.statuses === "total"
            ? stats.total
            : tile.statuses.reduce(
                (sum, s) => sum + (stats.by_status[s] ?? 0),
                0,
              );
        const content = (
          <>
            <span className="statValue">{value ?? "—"}</span>
            <span className="statLabel">{tile.label}</span>
            <span className="statHint">{tile.hint}</span>
          </>
        );
        return tile.filter ? (
          <a
            key={tile.label}
            className={`statTile tone-${tile.tone}`}
            href={`#/library?status=${tile.filter}`}
          >
            {content}
          </a>
        ) : (
          <a key={tile.label} className="statTile" href="#/library">
            {content}
          </a>
        );
      })}
    </section>
  );
}
