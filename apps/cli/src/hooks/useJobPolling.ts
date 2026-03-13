import { useEffect, useRef, useState } from 'react';
import type { CliStore } from '../store/index.js';
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

  useEffect(() => {
    mountedRef.current = true;

    async function fetchAll(): Promise<void> {
      if (!mountedRef.current) return;
      setIsPolling(true);
      setLastError(null);

      try {
        const [job, actions, schema, entities] = await Promise.all([
          apiClient.getJob(jobId),
          apiClient.listActions(jobId, { status: 'pending_review' }),
          apiClient.getSchema(jobId).catch(() => null),
          apiClient.listEntities(jobId, { limit: 5 }).catch(() => []),
        ]);

        if (!mountedRef.current) return;

        const state = store.getState();
        state.setJobData(job);
        state.setPendingActions(actions as Record<string, unknown>[]);
        if (schema) state.setSchemaData(schema);
        state.setEntityPreviews(entities as Record<string, unknown>[]);
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setLastError(message);
      } finally {
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
