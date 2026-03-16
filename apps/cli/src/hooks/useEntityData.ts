import { useEffect, useCallback, useMemo } from 'react';
import { useStdout } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { EntityWithProvenance } from '@spatula/shared';

const HEADER_HEIGHT = 3;
const FILTER_BAR_HEIGHT = 1;
const TABLE_HEADER_HEIGHT = 2;
const FOOTER_HEIGHT = 1;
const PADDING = 2;

export function useEntityData(
  store: CliStore,
  apiClient: SpatulaApiClient,
  jobId: string,
) {
  const { stdout } = useStdout();
  const pageSize = useMemo(() => {
    const rows = stdout?.rows ?? 40;
    return Math.max(5, rows - HEADER_HEIGHT - FILTER_BAR_HEIGHT - TABLE_HEADER_HEIGHT - FOOTER_HEIGHT - PADDING);
  }, [stdout?.rows]);

  const fetchPage = useCallback(async (page: number) => {
    if (!jobId) return;

    const state = store.getState();
    const offset = page * pageSize;

    try {
      const result = await apiClient.listEntitiesPaginated(jobId, {
        limit: pageSize,
        offset,
      });

      state.setEntities(result.data as any);
      state.setTotalEntityCount(result.total);
      state.setCurrentEntityPage(page);
      state.setSelectedEntityIndex(0);
    } catch (error) {
      state.setError(`Failed to fetch entities: ${(error as Error).message}`);
    }
  }, [store, apiClient, jobId, pageSize]);

  // Fetch initial page on mount
  useEffect(() => {
    fetchPage(0);
  }, [fetchPage]);

  // Use reactive store subscription for totalEntityCount
  const totalEntityCount = useStore(store, (s) => s.totalEntityCount);
  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(totalEntityCount / pageSize));
  }, [totalEntityCount, pageSize]);

  const goToPage = useCallback((page: number) => {
    const clamped = Math.max(0, Math.min(page, totalPages - 1));
    fetchPage(clamped);
  }, [fetchPage, totalPages]);

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

  const fetchEntity = useCallback(async (entityId: string): Promise<EntityWithProvenance> => {
    const data = await apiClient.getEntity(jobId, entityId);
    return data as unknown as EntityWithProvenance;
  }, [apiClient, jobId]);

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
