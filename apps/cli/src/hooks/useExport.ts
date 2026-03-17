import { useState, useCallback } from 'react';
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

export function useExport(apiClient: SpatulaApiClient) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ fetched: number; total: number } | null>(
    null,
  );

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
      options: { search?: string; filterQuery?: string; schemaFields: string[] },
    ): Promise<string> => {
      setIsExporting(true);
      setExportProgress({ fetched: 0, total: 0 });

      try {
        // First fetch to get total
        const first = await apiClient.listEntitiesPaginated(jobId, {
          limit: 100,
          offset: 0,
          ...(options.search ? { search: options.search } : {}),
        });

        const allEntities: Entity[] = [...(first.data as unknown as Entity[])];
        const total = first.total;
        setExportProgress({ fetched: allEntities.length, total });

        // Fetch remaining pages
        let offset = 100;
        while (offset < total) {
          const page = await apiClient.listEntitiesPaginated(jobId, {
            limit: 100,
            offset,
            ...(options.search ? { search: options.search } : {}),
          });
          allEntities.push(...(page.data as unknown as Entity[]));
          offset += 100;
          setExportProgress({ fetched: allEntities.length, total });
        }

        const filename = generateFilename(jobId, format);
        const filepath = join(process.cwd(), filename);

        const content =
          format === 'csv'
            ? entitiesToCsv(allEntities, options.schemaFields)
            : entitiesToJson(allEntities, { jobId, filterQuery: options.filterQuery });

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
