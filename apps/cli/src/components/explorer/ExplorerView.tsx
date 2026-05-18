import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import type { DataSource } from '@spatula/core';
import { useEntityData } from '../../hooks/useEntityData.js';
import { useEntityFilter } from '../../hooks/useEntityFilter.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { KeyboardHints } from '../shared/index.js';
import type { KeyHint } from '../shared/index.js';
import { Spinner } from '../shared/Spinner.js';
import { DataTable } from './DataTable.js';
import { FilterBar } from './FilterBar.js';
import { cycleSourceFilter } from './source-filter.js';
import type { SourceFilter } from './source-filter.js';
import { EntityDetail } from './EntityDetail.js';
import { ExportDialog } from './ExportDialog.js';

export interface FilteredFetch {
  getEntities(query: {
    limit: number;
    offset: number;
    sourceFilter: 'local' | 'remote';
  }): Promise<{ data: unknown[]; total: number }>;
}

export interface ExplorerViewProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
  filteredFetch?: FilteredFetch;
}

type SubView = 'table' | 'detail' | 'export';

// ---------------------------------------------------------------------------
// Keyboard hint sets per sub-view
// ---------------------------------------------------------------------------

const TABLE_HINTS: KeyHint[] = [
  { key: '↑/↓', description: 'Navigate' },
  { key: '←/→', description: 'Scroll columns' },
  { key: 'Enter', description: 'Detail' },
  { key: 'F', description: 'Filter' },
  { key: 'E', description: 'Export' },
  { key: 'N/P', description: 'Next/Prev page' },
  { key: 'S', description: 'Source filter' },
  { key: 'Esc', description: 'Exit' },
];

const FILTER_HINTS: KeyHint[] = [
  { key: 'A', description: 'Toggle AI' },
  { key: 'Esc', description: 'Unfocus' },
];

const DETAIL_HINTS: KeyHint[] = [
  { key: '↑/↓', description: 'Scroll' },
  { key: 'E', description: 'Export entity' },
  { key: 'Esc', description: 'Back to table' },
];

// ---------------------------------------------------------------------------
// Schema field extraction helper
// ---------------------------------------------------------------------------

function extractSchemaFields(schemaData: Record<string, unknown> | null): string[] {
  if (!schemaData) return [];

  // Try schemaData.fields (flat structure)
  const topFields = schemaData.fields;
  if (Array.isArray(topFields)) {
    return topFields.map((f: Record<string, unknown>) => String(f.name ?? '')).filter(Boolean);
  }

  // Try schemaData.definition.fields (nested structure)
  const definition = schemaData.definition as Record<string, unknown> | undefined;
  if (definition && Array.isArray(definition.fields)) {
    return (definition.fields as Array<Record<string, unknown>>)
      .map((f) => String(f.name ?? ''))
      .filter(Boolean);
  }

  return [];
}

// ---------------------------------------------------------------------------
// ExplorerView
// ---------------------------------------------------------------------------

export function ExplorerView({
  store,
  backend,
  filteredFetch,
}: ExplorerViewProps): React.ReactElement {
  // Local state
  const [subView, setSubView] = useState<SubView>('table');
  const [columnOffset, setColumnOffset] = useState(0);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);

  // Store state
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const entities = useStore(store, (s) => s.entities);
  const totalEntityCount = useStore(store, (s) => s.totalEntityCount);
  const currentEntityPage = useStore(store, (s) => s.currentEntityPage);
  const selectedEntityIndex = useStore(store, (s) => s.selectedEntityIndex);
  const expandedEntity = useStore(store, (s) => s.expandedEntity);
  const filterQuery = useStore(store, (s) => s.filterQuery);
  const filterMode = useStore(store, (s) => s.filterMode);
  const filterFocused = useStore(store, (s) => s.filterFocused);
  const schemaData = useStore(store, (s) => s.schemaData);

  const schemaFields = useMemo(() => extractSchemaFields(schemaData), [schemaData]);

  // Entity data hook (pagination)
  const { pageSize, totalPages, nextPage, prevPage, fetchEntity, fetchPage } = useEntityData(
    store,
    backend,
    activeJobId ?? '',
    {
      sourceFilter,
      filteredFetch,
    },
  );

  // Entity filter hook (local + server-side filtering)
  const { setFilterQuery: applyFilter, clearFilter } = useEntityFilter(
    store,
    backend,
    activeJobId ?? '',
    totalEntityCount,
  );

  // ---------------------------------------------------------------------------
  // Table keyboard handlers
  // ---------------------------------------------------------------------------

  const openDetail = useCallback(async () => {
    const entity = entities[selectedEntityIndex];
    if (!entity) return;

    setDetailLoading(true);
    setDetailError(null);
    setSubView('detail');

    try {
      const full = await fetchEntity(entity.id);
      store.getState().setExpandedEntity(full);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Failed to load entity');
    } finally {
      setDetailLoading(false);
    }
  }, [entities, selectedEntityIndex, fetchEntity, store]);

  const tableKeyMap = useMemo(
    () => ({
      upArrow: () => {
        const idx = store.getState().selectedEntityIndex;
        if (idx > 0) store.getState().setSelectedEntityIndex(idx - 1);
      },
      downArrow: () => {
        const idx = store.getState().selectedEntityIndex;
        const max = store.getState().entities.length - 1;
        if (idx < max) store.getState().setSelectedEntityIndex(idx + 1);
      },
      leftArrow: () => {
        setColumnOffset((prev) => Math.max(0, prev - 1));
      },
      rightArrow: () => {
        setColumnOffset((prev) => Math.min(prev + 1, Math.max(0, schemaFields.length - 1)));
      },
      return: () => {
        void openDetail();
      },
      f: () => {
        store.getState().setFilterFocused(true);
      },
      F: () => {
        store.getState().setFilterFocused(true);
      },
      '/': () => {
        store.getState().setFilterFocused(true);
      },
      e: () => {
        setSubView('export');
      },
      E: () => {
        setSubView('export');
      },
      s: () => setSourceFilter((f) => cycleSourceFilter(f)),
      S: () => setSourceFilter((f) => cycleSourceFilter(f)),
      n: nextPage,
      N: nextPage,
      p: prevPage,
      P: prevPage,
      ']': nextPage,
      '[': prevPage,
      escape: () => {
        store.getState().setMode('conversational');
      },
    }),
    [store, openDetail, nextPage, prevPage, schemaFields.length],
  );

  useKeyboard(tableKeyMap, subView === 'table' && !filterFocused);

  // ---------------------------------------------------------------------------
  // Detail keyboard handlers
  // ---------------------------------------------------------------------------

  const detailKeyMap = useMemo(
    () => ({
      upArrow: () => {
        setDetailScrollOffset((o) => Math.max(0, o - 1));
      },
      downArrow: () => {
        setDetailScrollOffset((o) => o + 1);
      },
      escape: () => {
        store.getState().setExpandedEntity(null);
        setDetailError(null);
        setDetailScrollOffset(0);
        setSubView('table');
      },
      e: () => {
        setSubView('export');
      },
      E: () => {
        setSubView('export');
      },
    }),
    [store],
  );

  useKeyboard(detailKeyMap, subView === 'detail');

  // ---------------------------------------------------------------------------
  // Filter callbacks
  // ---------------------------------------------------------------------------

  const handleFilterQueryChange = useCallback(
    (query: string) => {
      applyFilter(query);
    },
    [applyFilter],
  );

  const handleFilterToggleMode = useCallback(() => {
    const current = store.getState().filterMode;
    store.getState().setFilterMode(current === 'local' ? 'ai' : 'local');
  }, [store]);

  const handleFilterSubmit = useCallback(() => {
    // Submit filter — unfocus and stay on table
    store.getState().setFilterFocused(false);
  }, [store]);

  const handleFilterBlur = useCallback(() => {
    store.getState().setFilterFocused(false);
    if (filterQuery) {
      clearFilter();
      fetchPage(0); // re-fetch unfiltered data
    }
  }, [store, filterQuery, clearFilter, fetchPage]);

  const handleExportClose = useCallback(() => {
    setSubView(expandedEntity ? 'detail' : 'table');
  }, [expandedEntity]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!activeJobId) {
    return <Text dimColor>No active job. Start a job in conversational mode first.</Text>;
  }

  // Detail sub-view
  if (subView === 'detail') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {detailLoading && <Spinner label="Loading entity details..." />}
        {detailError && <Text color="red">Error: {detailError}</Text>}
        {!detailLoading && !detailError && expandedEntity && (
          <EntityDetail entity={expandedEntity} scrollOffset={detailScrollOffset} />
        )}
        {!detailLoading && !detailError && !expandedEntity && (
          <Text dimColor>No entity selected.</Text>
        )}
        <KeyboardHints hints={DETAIL_HINTS} />
      </Box>
    );
  }

  // Export overlay
  if (subView === 'export') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <ExportDialog
          store={store}
          backend={backend}
          fromDetail={expandedEntity !== null}
          onClose={handleExportClose}
        />
      </Box>
    );
  }

  // Table sub-view (default)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <FilterBar
        filterQuery={filterQuery}
        filterMode={filterMode}
        matchCount={entities.length}
        totalCount={totalEntityCount}
        focused={filterFocused}
        onQueryChange={handleFilterQueryChange}
        onToggleMode={handleFilterToggleMode}
        onSubmit={handleFilterSubmit}
        onBlur={handleFilterBlur}
      />
      <DataTable
        entities={entities}
        schemaFields={schemaFields}
        selectedIndex={selectedEntityIndex}
        currentPage={currentEntityPage}
        totalPages={totalPages}
        totalCount={totalEntityCount}
        columnOffset={columnOffset}
        pageSize={pageSize}
        sourceFilter={sourceFilter === 'all' ? undefined : sourceFilter}
      />
      <KeyboardHints hints={filterFocused ? FILTER_HINTS : TABLE_HINTS} />
    </Box>
  );
}
