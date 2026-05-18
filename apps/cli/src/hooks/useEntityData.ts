import { useEffect, useCallback, useMemo } from 'react';
import { useStdout } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { DataSource } from '@spatula/core';
import type { EntityWithProvenance } from '@spatula/shared';
import { isDataSource } from './useJobPolling.js';

const HEADER_HEIGHT = 3;
const FILTER_BAR_HEIGHT = 1;
const TABLE_HEADER_HEIGHT = 2;
const FOOTER_HEIGHT = 1;
const PADDING = 2;

interface FilteredFetch {
  getEntities(query: {
    limit: number;
    offset: number;
    sourceFilter: 'local' | 'remote';
  }): Promise<{ data: unknown[]; total: number }>;
}

export function useEntityData(
  store: CliStore,
  backend: DataSource | SpatulaApiClient,
  jobId: string,
  options?: { sourceFilter?: 'all' | 'local' | 'remote'; filteredFetch?: FilteredFetch },
) {
  const { stdout } = useStdout();
  const pageSize = useMemo(() => {
    const rows = stdout?.rows ?? 40;
    return Math.max(
      5,
      rows - HEADER_HEIGHT - FILTER_BAR_HEIGHT - TABLE_HEADER_HEIGHT - FOOTER_HEIGHT - PADDING,
    );
  }, [stdout?.rows]);

  const sourceFilter = options?.sourceFilter ?? 'all';
  const filteredFetch = options?.filteredFetch;

  const fetchPage = useCallback(
    async (page: number) => {
      if (!jobId && !isDataSource(backend)) return;

      const state = store.getState();
      const offset = page * pageSize;

      try {
        // Use filtered fetch when source filter is active and available
        if (sourceFilter !== 'all' && filteredFetch) {
          const result = await filteredFetch.getEntities({
            limit: pageSize,
            offset,
            sourceFilter: sourceFilter as 'local' | 'remote',
          });
          state.setEntities(result.data as any);
          state.setTotalEntityCount(result.total);
        } else if (isDataSource(backend)) {
          const result = await backend.getEntities({ limit: pageSize, offset });
          state.setEntities(result.data as any);
          state.setTotalEntityCount(result.total);
        } else {
          const result = await backend.listEntitiesPaginated(jobId, {
            limit: pageSize,
            offset,
          });
          state.setEntities(result.data as any);
          state.setTotalEntityCount(result.total);
        }
        state.setCurrentEntityPage(page);
        state.setSelectedEntityIndex(0);
      } catch (error) {
        state.setError(`Failed to fetch entities: ${(error as Error).message}`);
      }
    },
    [store, backend, jobId, pageSize, sourceFilter, filteredFetch],
  );

  useEffect(() => {
    fetchPage(0);
  }, [fetchPage]);

  const totalEntityCount = useStore(store, (s) => s.totalEntityCount);
  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(totalEntityCount / pageSize));
  }, [totalEntityCount, pageSize]);

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(0, Math.min(page, totalPages - 1));
      fetchPage(clamped);
    },
    [fetchPage, totalPages],
  );

  const nextPage = useCallback(() => {
    const current = store.getState().currentEntityPage;
    if (current < totalPages - 1) {
      fetchPage(current + 1);
    }
  }, [store, fetchPage, totalPages]);

  const prevPage = useCallback(() => {
    const current = store.getState().currentEntityPage;
    if (current > 0) {
      fetchPage(current - 1);
    }
  }, [store, fetchPage]);

  const fetchEntity = useCallback(
    async (entityId: string): Promise<EntityWithProvenance> => {
      if (isDataSource(backend)) {
        const entity = await backend.getEntity(entityId);
        if (!entity) throw new Error(`Entity not found: ${entityId}`);
        return entity as unknown as EntityWithProvenance;
      }
      const data = await backend.getEntity(jobId, entityId);
      return data as unknown as EntityWithProvenance;
    },
    [backend, jobId],
  );

  return {
    pageSize,
    totalPages,
    goToPage,
    nextPage,
    prevPage,
    fetchEntity,
    fetchPage,
  };
}
