/**
 * `spatula explore` -- standalone TUI for browsing entities from the local
 * project database.
 *
 * Opens the local project, checks for entities, and renders the ExplorerView
 * component with a DataSource backend.  Adds `q` to quit and `o` to cycle
 * sort order (default -> quality -> date -> default).
 */

import React, { useState, useCallback, useMemo } from 'react';
import { render, Box, Text } from 'ink';
import { openLocalProject } from '../local-project.js';
import { createCliStore } from '../store/index.js';
import type { CliStore } from '../store/index.js';
import type { DataSource } from '@spatula/core';
import { ExplorerView } from '../components/explorer/ExplorerView.js';
import type { FilteredFetch } from '../components/explorer/ExplorerView.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import { Header } from '../components/shared/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortOrder = 'default' | 'quality' | 'date' | 'name';

const SORT_CYCLE: SortOrder[] = ['default', 'quality', 'date', 'name'];

// ---------------------------------------------------------------------------
// Store factory -- exported for testability
// ---------------------------------------------------------------------------

/**
 * Build a CliStore pre-configured for standalone explorer mode.
 */
export function buildExploreStore(projectId: string): CliStore {
  const store = createCliStore(projectId);
  const state = store.getState();
  state.setActiveJobId(projectId);
  state.setMode('explorer');
  return store;
}

// ---------------------------------------------------------------------------
// Wrapper component
// ---------------------------------------------------------------------------

interface ExploreAppProps {
  store: CliStore;
  backend: DataSource;
  filteredFetch?: FilteredFetch;
  onQuit: () => void;
}

function ExploreApp({ store, backend, filteredFetch, onQuit }: ExploreAppProps): React.ReactElement {
  const [sortOrder, setSortOrder] = useState<SortOrder>('default');

  const applySort = useCallback((order: SortOrder) => {
    const state = store.getState();
    if (order === 'quality') {
      state.setEntities([...state.entities].sort((a, b) => b.qualityScore - a.qualityScore));
    } else if (order === 'date') {
      state.setEntities([...state.entities].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } else if (order === 'name') {
      state.setEntities([...state.entities].sort((a, b) => {
        const aKeys = Object.keys(a.mergedData).sort();
        const bKeys = Object.keys(b.mergedData).sort();
        return String(a.mergedData[aKeys[0]] ?? '').localeCompare(String(b.mergedData[bKeys[0]] ?? ''));
      }));
    } else {
      // 'default' — re-fetch page 0 to restore server order
      void backend.getEntities({ limit: 20, offset: 0 }).then((result) => {
        state.setEntities(result.data);
        state.setCurrentEntityPage(0);
        state.setSelectedEntityIndex(0);
      });
    }
  }, [store, backend]);

  const cycleSortOrder = useCallback(() => {
    const currentIdx = SORT_CYCLE.indexOf(sortOrder);
    const nextIdx = (currentIdx + 1) % SORT_CYCLE.length;
    const next = SORT_CYCLE[nextIdx];
    setSortOrder(next);
    applySort(next);
  }, [sortOrder, applySort]);

  const keyMap = useMemo(
    () => ({
      q: onQuit,
      Q: onQuit,
      o: cycleSortOrder,
      O: cycleSortOrder,
    }),
    [onQuit, cycleSortOrder],
  );

  useKeyboard(keyMap);

  return (
    <Box flexDirection="column">
      <Header mode="explorer" />
      <Text dimColor>
        Sort: {sortOrder} | Press <Text bold>o</Text> to cycle | <Text bold>q</Text> to quit
      </Text>
      <ExplorerView store={store} backend={backend} filteredFetch={filteredFetch} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runExploreCommand(): Promise<void> {
  // 1. Open local project
  const project = await openLocalProject(process.cwd());

  try {
    // 2. Check if entities exist
    const status = await project.dataSource.getStatus();

    if (status.totalEntities === 0) {
      console.log('No entities found. Run `spatula run` to crawl and extract data first.');
      return;
    }

    // 3. Create store configured for explorer mode
    const store = buildExploreStore(project.projectId);

    // 4. Build filtered-fetch bridge from adapter
    const projectId = project.projectId;
    const filteredFetch: FilteredFetch = {
      async getEntities(query) {
        const [rows, total] = await Promise.all([
          project.adapter.entityRepo.findByJobFiltered(projectId, projectId, {
            limit: query.limit,
            offset: query.offset,
            sourceFilter: query.sourceFilter,
          }),
          project.adapter.entityRepo.countBySource(query.sourceFilter),
        ]);
        return { data: rows, total };
      },
    };

    // 5. Render the Ink app
    const { unmount, waitUntilExit } = render(
      <ExploreApp
        store={store}
        backend={project.dataSource}
        filteredFetch={filteredFetch}
        onQuit={() => unmount()}
      />,
    );

    // 5. Wait for exit
    await waitUntilExit();
  } finally {
    project.close();
  }
}
