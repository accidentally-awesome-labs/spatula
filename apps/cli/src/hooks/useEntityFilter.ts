import { useEffect, useCallback, useRef } from 'react';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { DataSource } from '@spatula/core';
import type { Entity } from '@spatula/shared';
import { isDataSource } from './useJobPolling.js';

export function filterEntitiesLocally(entities: Entity[], query: string): Entity[] {
  if (!query) return entities;
  const lower = query.toLowerCase();
  return entities.filter((entity) => {
    const values = Object.values(entity.mergedData);
    return values.some((v) => {
      if (v === null || v === undefined) return false;
      return String(v).toLowerCase().includes(lower);
    });
  });
}

export function useEntityFilter(
  store: CliStore,
  backend: DataSource | SpatulaApiClient,
  jobId: string,
  totalCount: number,
) {
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unfilteredEntities = useRef<Entity[]>([]);
  const useLocalMode = isDataSource(backend);

  const applyLocalFilter = useCallback(
    (query: string) => {
      const state = store.getState();
      if (unfilteredEntities.current.length === 0) {
        unfilteredEntities.current = [...state.entities];
      }
      if (!query) {
        state.setEntities(unfilteredEntities.current);
        return;
      }
      const filtered = filterEntitiesLocally(unfilteredEntities.current, query);
      state.setEntities(filtered);
    },
    [store],
  );

  const applyServerFilter = useCallback(
    async (query: string, page = 0, pageSize = 50) => {
      if (isDataSource(backend)) {
        applyLocalFilter(query);
        return;
      }
      try {
        const result = await backend.listEntitiesPaginated(jobId, {
          limit: pageSize,
          offset: page * pageSize,
          search: query,
        });
        const state = store.getState();
        state.setEntities(result.data as unknown as Entity[]);
        state.setTotalEntityCount(result.total);
        state.setCurrentEntityPage(page);
        state.setSelectedEntityIndex(0);
      } catch (error) {
        store.getState().setError(`Filter failed: ${(error as Error).message}`);
      }
    },
    [store, backend, jobId, applyLocalFilter],
  );

  const setFilterQuery = useCallback(
    (query: string) => {
      store.getState().setFilterQuery(query);
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(() => {
        if (useLocalMode || totalCount < 500) {
          applyLocalFilter(query);
        } else {
          applyServerFilter(query);
        }
      }, 200);
    },
    [store, totalCount, useLocalMode, applyLocalFilter, applyServerFilter],
  );

  const clearFilter = useCallback(() => {
    store.getState().setFilterQuery('');
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    if (unfilteredEntities.current.length > 0) {
      store.getState().setEntities(unfilteredEntities.current);
      unfilteredEntities.current = [];
    }
  }, [store]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  return { setFilterQuery, clearFilter, applyServerFilter };
}
