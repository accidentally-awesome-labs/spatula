import { useState, useCallback, useRef } from 'react';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpatulaApiClient } from '../api/client.js';
import type { DataSource } from '@spatula/core';
import type { Entity, EntityWithProvenance } from '@spatula/shared';
import { entitiesToCsv, entityToCsvRow } from '@spatula/core';
import { isDataSource } from './useJobPolling.js';

export { entityToCsvRow };

function entitiesToJson(
  entities: Entity[],
  options: { jobId: string; filterQuery?: string },
): string {
  return JSON.stringify(
    {
      metadata: {
        jobId: options.jobId,
        exportedAt: new Date().toISOString(),
        count: entities.length,
        ...(options.filterQuery ? { filterQuery: options.filterQuery } : {}),
      },
      entities: entities.map((e) => ({
        data: e.mergedData,
        provenance: (e as EntityWithProvenance).provenance ?? null,
        qualityScore: e.qualityScore,
        categories: e.categories,
        sourceCount: e.sourceCount,
      })),
    },
    null,
    2,
  );
}

function generateFilename(jobId: string, format: 'json' | 'csv'): string {
  const short = jobId.slice(0, 8);
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `spatula-${short}-${ts}.${format}`;
}

export interface ExportProgress {
  status: string;
  entityCount?: number;
}

export function useExport(backend: DataSource | SpatulaApiClient) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const abortRef = useRef(false);

  const exportSingleEntity = useCallback(
    async (
      entity: EntityWithProvenance,
      format: 'json' | 'csv',
      options: { jobId: string },
    ): Promise<string> => {
      const filename = generateFilename(options.jobId, format);
      const filepath = join(process.cwd(), filename);
      const fields = Object.keys(entity.mergedData);
      const content =
        format === 'csv' ? entitiesToCsv([entity], fields) : entitiesToJson([entity], options);
      await writeFile(filepath, content, 'utf-8');
      return filepath;
    },
    [],
  );

  const exportEntitySet = useCallback(
    async (
      targetJobId: string,
      format: 'json' | 'csv',
      options: { search?: string; filterQuery?: string; schemaFields: string[]; includeProvenance?: boolean },
    ): Promise<string> => {
      setIsExporting(true);
      setExportProgress({ status: 'pending' });
      abortRef.current = false;
      try {
        if (isDataSource(backend)) {
          return await exportFromDataSource(backend, targetJobId, format, options);
        }
        return await exportFromApi(backend, targetJobId, format, options, abortRef, setExportProgress);
      } finally {
        setIsExporting(false);
        setExportProgress(null);
      }
    },
    [backend],
  );

  return { isExporting, exportProgress, exportSingleEntity, exportEntitySet };
}

export async function exportFromDataSource(
  ds: DataSource,
  jobId: string,
  format: 'json' | 'csv',
  options: { filterQuery?: string; schemaFields: string[]; includeProvenance?: boolean },
): Promise<string> {
  const allEntities: Entity[] = [];
  let offset = 0;
  const batchSize = 200;
  while (true) {
    const result = await ds.getEntities({ limit: batchSize, offset });
    allEntities.push(...result.data);
    if (allEntities.length >= result.total) break;
    offset += batchSize;
  }
  const filename = generateFilename(jobId, format);
  const filepath = join(process.cwd(), filename);
  const content =
    format === 'csv'
      ? entitiesToCsv(allEntities, options.schemaFields)
      : entitiesToJson(allEntities, { jobId, filterQuery: options.filterQuery });
  await writeFile(filepath, content, 'utf-8');
  return filepath;
}

async function exportFromApi(
  apiClient: SpatulaApiClient,
  jobId: string,
  format: 'json' | 'csv',
  options: { includeProvenance?: boolean },
  abortRef: { current: boolean },
  setExportProgress: (p: ExportProgress) => void,
): Promise<string> {
  const exportRecord = await apiClient.createExport(jobId, {
    format,
    includeProvenance: options.includeProvenance,
  });
  const exportId = exportRecord.id as string;
  setExportProgress({ status: 'pending' });
  const MAX_POLL_MS = 5 * 60 * 1000;
  const pollStart = Date.now();
  let status = 'pending';
  while (status !== 'completed' && status !== 'failed' && !abortRef.current) {
    if (Date.now() - pollStart > MAX_POLL_MS) {
      throw new Error('Export timed out — check server logs');
    }
    await new Promise((r) => setTimeout(r, 1000));
    const record = await apiClient.getExport(jobId, exportId);
    status = record.status as string;
    setExportProgress({
      status,
      entityCount: record.entityCount as number | undefined,
    });
  }
  if (status === 'failed') throw new Error('Export failed on server');
  if (abortRef.current) throw new Error('Export cancelled');
  const content = await apiClient.downloadExport(jobId, exportId);
  const filename = generateFilename(jobId, format);
  const filepath = join(process.cwd(), filename);
  await writeFile(filepath, content, 'utf-8');
  return filepath;
}
