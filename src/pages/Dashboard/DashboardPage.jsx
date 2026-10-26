import { useCallback, useEffect, useState } from "react";
import { BulkUrlInput } from "../../components/BulkUrlInput/BulkUrlInput";
import { ProcessingQueue } from "../../components/ProcessingQueue/ProcessingQueue";
import { StatsOverview } from "../../components/StatsOverview";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { useAppConfig } from "../../lib/config";
import { useInterval, useStoredState } from "../../lib/hooks";

export function DashboardPage() {
  const config = useAppConfig();
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [batchId, setBatchId] = useStoredState("mu.currentBatchId", null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.stats());
    } catch (err) {
      toast.error(`Could not load statistics: ${err.message}`);
    } finally {
      setStatsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const processing =
    (stats?.by_status.queued ?? 0) + (stats?.by_status.processing ?? 0) > 0;
  useInterval(() => void loadStats(), 5000, processing);

  const submit = async (urls) => {
    try {
      const result = await api.submitBatch(urls);
      const skipped = result.skipped.length;
      if (result.batch) {
        setBatchId(result.batch.id);
        setRefreshKey((k) => k + 1);
        toast.success(
          `${result.queued.length} article${result.queued.length === 1 ? "" : "s"} queued${skipped ? `, ${skipped} skipped` : ""}.`,
        );
      } else {
        toast.info(
          skipped
            ? `Nothing new to process: ${result.skipped[0].message}`
            : "Nothing to process.",
        );
      }
      void loadStats();
      return true;
    } catch (err) {
      toast.error(err.message);
      return false;
    }
  };

  return (
    <div className="pageStack">
      {config.storage === "memory" && (
        <div className="callout calloutInfo" role="status">
          <strong>Sample mode.</strong> Supabase is not connected, so cards are
          kept in server memory and disappear when the server restarts. Add
          SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env to store them
          permanently.
        </div>
      )}
      {!config.cdn_configured && (
        <div className="callout calloutWarning" role="status">
          <strong>CDN not configured.</strong> Metadata will be extracted and
          saved, but thumbnails cannot be uploaded until the CDN_* settings are
          configured on the server. Affected jobs can be retried afterwards.
        </div>
      )}
      <StatsOverview stats={stats} loading={statsLoading} />
      <BulkUrlInput maxBatchSize={config.max_batch_size} onSubmit={submit} />
      <ProcessingQueue
        batchId={batchId}
        refreshKey={refreshKey}
        onSelectBatch={setBatchId}
        onActivityChange={loadStats}
      />
    </div>
  );
}
