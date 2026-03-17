import { useState, useCallback, useRef } from 'react';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpatulaApiClient } from '../api/client.js';
import type { Entity, EntityWithProvenance } from '@spatula/shared';
import { entitiesToCsv, entityToCsvRow } from '@spatula/core';

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

export function useExport(apiClient: SpatulaApiClient) {
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
      jobId: string,
      format: 'json' | 'csv',
      _options: { search?: string; filterQuery?: string; schemaFields: string[] },
    ): Promise<string> => {
      setIsExporting(true);
      setExportProgress({ status: 'pending' });
      abortRef.current = false;

      try {
        // 1. Trigger server-side export
        const exportRecord = await apiClient.createExport(jobId, { format });
        const exportId = exportRecord.id as string;
        setExportProgress({ status: 'pending' });

        // 2. Poll for completion
        let status = 'pending';
        while (status !== 'completed' && status !== 'failed' && !abortRef.current) {
          await new Promise((r) => setTimeout(r, 1000));
          const record = await apiClient.getExport(jobId, exportId);
          status = record.status as string;
          setExportProgress({
            status,
            entityCount: record.entityCount as number | undefined,
          });
        }

        if (status === 'failed') {
          throw new Error('Export failed on server');
        }
        if (abortRef.current) {
          throw new Error('Export cancelled');
        }

        // 3. Download
        const content = await apiClient.downloadExport(jobId, exportId);

        // 4. Write to file
        const filename = generateFilename(jobId, format);
        const filepath = join(process.cwd(), filename);
        await writeFile(filepath, content, 'utf-8');
        return filepath;
      } finally {
        setIsExporting(false);
        setExportProgress(null);
      }
    },
    [apiClient],
  );

  return { isExporting, exportProgress, exportSingleEntity, exportEntitySet };
}
