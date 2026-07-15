import { useEffect, useRef, useState } from 'react';
import type { CliStore, PendingAction } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { DataSource } from '@accidentally-awesome-labs/spatula-core';

const DEFAULT_INTERVAL = 3000;

export interface UseJobPollingResult {
  isPolling: boolean;
  lastError: string | null;
}

/**
 * Type guard: DataSource has getEntities/getStatus/getSchema/getActions methods
 * but NOT getJob (which is ApiClient-specific).
 */
export function isDataSource(backend: DataSource | SpatulaApiClient): backend is DataSource {
  return 'getEntities' in backend && 'getStatus' in backend && !('getJob' in backend);
}

export function useJobPolling(
  store: CliStore,
  backend: DataSource | SpatulaApiClient,
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
        if (isDataSource(backend)) {
          await fetchFromDataSource(store, backend);
        } else {
          await fetchFromApi(store, backend, jobId);
        }
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
  }, [store, backend, jobId, interval]);

  return { isPolling, lastError };
}

export async function fetchFromDataSource(store: CliStore, ds: DataSource): Promise<void> {
  const [status, pendingActions, schema, entityResult] = await Promise.all([
    ds.getStatus(),
    ds.getActions('pending_review'),
    ds.getSchema().catch(() => null),
    ds.getEntities({ limit: 5 }).catch(() => ({ data: [], total: 0 })),
  ]);

  const state = store.getState();
  state.setJobData(status as unknown as Record<string, unknown>);
  state.setPendingActions(pendingActions as PendingAction[]);
  state.setRecentActions([]); // Local mode — no recent actions distinction
  if (schema) state.setSchemaData(schema as Record<string, unknown>);
  state.setEntityPreviews(entityResult.data as unknown as Record<string, unknown>[]);
}

async function fetchFromApi(
  store: CliStore,
  apiClient: SpatulaApiClient,
  jobId: string,
): Promise<void> {
  const [job, pendingActions, recentActions, schema, entities] = await Promise.all([
    apiClient.getJob(jobId),
    apiClient.listActions(jobId, { status: 'pending_review' }),
    apiClient.listActions(jobId, { limit: 20 }).catch(() => []),
    apiClient.getSchema(jobId).catch(() => null),
    apiClient.listEntities(jobId, { limit: 5 }).catch(() => []),
  ]);

  const state = store.getState();
  state.setJobData(job);
  state.setPendingActions(pendingActions as PendingAction[]);
  state.setRecentActions(recentActions as PendingAction[]);
  if (schema) state.setSchemaData(schema);
  state.setEntityPreviews(entities as Record<string, unknown>[]);
}
