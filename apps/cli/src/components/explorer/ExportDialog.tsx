import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { useExport } from '../../hooks/useExport.js';
import { Panel } from '../shared/index.js';
import type { EntityWithProvenance } from '@spatula/shared';

export interface ExportDialogProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
  fromDetail: boolean;
  onClose: () => void;
}

type ExportFormat = 'json' | 'csv';
type ExportScope = 'entity' | 'set';

export function ExportDialog({ store, apiClient, fromDetail, onClose }: ExportDialogProps) {
  const totalEntityCount = useStore(store, (s) => s.totalEntityCount);
  const filterQuery = useStore(store, (s) => s.filterQuery);
  const expandedEntity = useStore(store, (s) => s.expandedEntity);
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const schemaData = useStore(store, (s) => s.schemaData);

  const [format, setFormat] = useState<ExportFormat>('json');
  const [scope, setScope] = useState<ExportScope>(fromDetail ? 'entity' : 'set');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { isExporting, exportProgress, exportSingleEntity, exportEntitySet } = useExport(apiClient);

  const schemaFields = (() => {
    if (!schemaData) return [];
    const definition = (schemaData as any).definition ?? schemaData;
    const fields = (definition as any)?.fields ?? [];
    return fields.map((f: any) => f.name as string);
  })();

  const doExport = useCallback(async () => {
    if (!activeJobId) return;

    try {
      let filepath: string;
      if (scope === 'entity' && expandedEntity) {
        filepath = await exportSingleEntity(expandedEntity as EntityWithProvenance, format, {
          jobId: activeJobId,
        });
      } else {
        filepath = await exportEntitySet(activeJobId, format, {
          search: filterQuery || undefined,
          filterQuery: filterQuery || undefined,
          schemaFields,
        });
      }
      setResult(filepath);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeJobId, scope, expandedEntity, format, filterQuery, schemaFields, exportSingleEntity, exportEntitySet]);

  useKeyboard(
    {
      leftArrow: () => setFormat((f) => (f === 'json' ? 'csv' : 'json')),
      rightArrow: () => setFormat((f) => (f === 'json' ? 'csv' : 'json')),
      upArrow: () => fromDetail && setScope((s) => (s === 'entity' ? 'set' : 'entity')),
      downArrow: () => fromDetail && setScope((s) => (s === 'entity' ? 'set' : 'entity')),
      return: () => doExport(),
      escape: () => onClose(),
    },
    !isExporting,
  );

  const setLabel = filterQuery
    ? `Filtered results (${totalEntityCount})`
    : `All results (${totalEntityCount})`;

  if (result) {
    return (
      <Panel title="Export">
        <Text color="green">Exported to {result}</Text>
        <Text dimColor> Press Escape to close.</Text>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel title="Export">
        <Text color="red">Export failed: {error}</Text>
        <Text dimColor> Press Escape to close.</Text>
      </Panel>
    );
  }

  if (isExporting && exportProgress) {
    return (
      <Panel title="Export">
        <Text>
          {exportProgress.status === 'pending' && 'Export pending...'}
          {exportProgress.status === 'processing' && 'Processing export...'}
          {exportProgress.entityCount != null && ` (${exportProgress.entityCount} entities)`}
        </Text>
      </Panel>
    );
  }

  return (
    <Panel title="Export">
      <Box flexDirection="column">
        <Box>
          <Text bold>Format:   </Text>
          <Text color={format === 'json' ? 'cyan' : undefined} bold={format === 'json'}>
            {format === 'json' ? '[JSON]' : ' JSON '}
          </Text>
          <Text>{'  '}</Text>
          <Text color={format === 'csv' ? 'cyan' : undefined} bold={format === 'csv'}>
            {format === 'csv' ? '[CSV]' : ' CSV '}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Scope:    </Text>
          {fromDetail && (
            <Text color={scope === 'entity' ? 'cyan' : undefined} bold={scope === 'entity'}>
              {scope === 'entity' ? '[Current entity]' : ' Current entity '}
            </Text>
          )}
          <Text color={scope === 'set' ? 'cyan' : undefined} bold={scope === 'set'}>
            {scope === 'set' ? `[${setLabel}]` : ` ${setLabel} `}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Enter to export {'\u00b7'} Escape to cancel</Text>
        </Box>
      </Box>
    </Panel>
  );
}
