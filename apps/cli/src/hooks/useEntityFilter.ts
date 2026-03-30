// TODO(Wave 3-5): Accept DataSource instead of ApiClient for local mode
// In local mode, call dataSource methods instead of apiClient methods

import { useEffect, useCallback, useRef } from 'react';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import type { Entity } from '@spatula/shared';

/**
 * Case-insensitive text filter across all mergedData field values.
 * Exported for direct testing.
 */
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
  apiClient: SpatulaApiClient,
  jobId: string,
  totalCount: number,
) {
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a snapshot of unfiltered entities for local filtering
  const unfilteredEntities = useRef<Entity[]>([]);

  const applyLocalFilter = useCallback(
    (query: string) => {
      const state = store.getState();
      // On first filter, snapshot current entities
      if (unfilteredEntities.current.length === 0) {
        unfilteredEntities.current = [...state.entities];
      }
      if (!query) {
        // Restore original entities
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
      try {
        const result = await apiClient.listEntitiesPaginated(jobId, {
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
    [store, apiClient, jobId],
  );

  // Debounced filter application
  const setFilterQuery = useCallback(
    (query: string) => {
      store.getState().setFilterQuery(query);

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        if (totalCount < 500) {
          applyLocalFilter(query);
        } else {
          applyServerFilter(query);
        }
      }, 200);
    },
    [store, totalCount, applyLocalFilter, applyServerFilter],
  );

  const clearFilter = useCallback(() => {
    store.getState().setFilterQuery('');
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    // Restore unfiltered snapshot for local filter; for server filter, caller re-fetches
    if (unfilteredEntities.current.length > 0) {
      store.getState().setEntities(unfilteredEntities.current);
      unfilteredEntities.current = [];
    }
  }, [store]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  return {
    setFilterQuery,
    clearFilter,
    applyServerFilter,
  };
}
