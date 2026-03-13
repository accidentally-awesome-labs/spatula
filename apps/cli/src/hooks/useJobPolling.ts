import { useEffect, useRef, useState } from 'react';
import type { CliStore, PendingAction } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';

const DEFAULT_INTERVAL = 3000;

export interface UseJobPollingResult {
  isPolling: boolean;
  lastError: string | null;
}

export function useJobPolling(
  store: CliStore,
  apiClient: SpatulaApiClient,
  jobId: string,
  interval: number = DEFAULT_INTERVAL,
): UseJobPollingResult {
  const [isPolling, setIsPolling] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    async function fetchAll(): Promise<void> {
      if (!mountedRef.current || !jobId || inFlightRef.current) return;
      inFlightRef.current = true;
      setIsPolling(true);
      setLastError(null);

      try {
        const [job, pendingActions, recentActions, schema, entities] = await Promise.all([
          apiClient.getJob(jobId),
          apiClient.listActions(jobId, { status: 'pending_review' }),
          apiClient.listActions(jobId, { limit: 20 }).catch(() => []),
          apiClient.getSchema(jobId).catch(() => null),
          apiClient.listEntities(jobId, { limit: 5 }).catch(() => []),
        ]);

        if (!mountedRef.current) return;

        const state = store.getState();
        state.setJobData(job);
        state.setPendingActions(pendingActions as PendingAction[]);
        state.setRecentActions(recentActions as PendingAction[]);
        if (schema) state.setSchemaData(schema);
        state.setEntityPreviews(entities as Record<string, unknown>[]);
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setLastError(message);
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setIsPolling(false);
      }
    }

    fetchAll();

    const timer = setInterval(fetchAll, interval);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [store, apiClient, jobId, interval]);

  return { isPolling, lastError };
}
