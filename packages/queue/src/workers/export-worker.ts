import { createLogger } from '@spatula/shared';
import { CsvExporter, JsonExporter, generateDocumentation } from '@spatula/core';
import type { SchemaDefinition } from '@spatula/core';
import type { Entity } from '@spatula/shared';
import type { ExportJobPayload } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('export-worker');

export async function processExportJob(
  data: ExportJobPayload,
  deps: WorkerDeps,
): Promise<void> {
  const { exportId, jobId, tenantId, format, includeProvenance } = data;

  try {
    // 1. Mark as processing
    await deps.exportRepo.updateStatus(exportId, tenantId, { status: 'processing' });

    // 2. Fetch schema
    const schemaRow = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schemaRow) {
      throw new Error('No schema found for job');
    }
    const schema = schemaRow.definition as SchemaDefinition;

    // 3. Fetch all entities in batches
    const allEntities: Entity[] = [];
    const total = await deps.entityRepo.countByJob(jobId, tenantId);

    const MAX_EXPORT_ENTITIES = 50_000;
    if (total > MAX_EXPORT_ENTITIES) {
      throw new Error(`Export too large: ${total} entities exceeds maximum of ${MAX_EXPORT_ENTITIES}. Consider filtering first.`);
    }
    let offset = 0;
    while (offset < total) {
      const batch = await deps.entityRepo.findByJob(jobId, tenantId, {
        limit: 100,
        offset,
      });
      allEntities.push(...(batch as unknown as Entity[]));
      offset += 100;
    }

    // 4. Generate documentation (for JSON)
    const documentation = format === 'json'
      ? generateDocumentation(schema, allEntities, jobId)
      : null;

    // 5. Run exporter
    // Note: findByJob excludes the provenance column for efficiency. When
    // includeProvenance is true, entity.provenance will be undefined — the
    // JsonExporter gracefully skips it. A findByJobWithProvenance method is
    // needed to fully support this flag (tracked as follow-up).
    const exporter = format === 'csv' ? new CsvExporter() : new JsonExporter();
    const result = await exporter.export(allEntities, schema, {
      format,
      includeProvenance,
      includeDocumentation: format === 'json',
    });

    // 6. For JSON, wrap with envelope
    let content: string;
    if (format === 'json') {
      const envelope = {
        metadata: {
          jobId,
          exportedAt: new Date().toISOString(),
          entityCount: allEntities.length,
          schemaVersion: schema.version,
          format: 'json',
          includeProvenance,
        },
        schema,
        documentation,
        entities: JSON.parse(result.data as string),
      };
      content = JSON.stringify(envelope, null, 2);
    } else {
      content = result.data as string;
    }

    // 7. Store in content store
    const key = `exports/${tenantId}/${jobId}/${exportId}.${format}`;
    const contentRef = await deps.contentStore.store(key, content);

    // 8. Mark as completed
    await deps.exportRepo.updateStatus(exportId, tenantId, {
      status: 'completed',
      entityCount: allEntities.length,
      contentRef,
      fileSize: Buffer.byteLength(content, 'utf-8'),
      completedAt: new Date(),
    });

    logger.info({ exportId, jobId, format, entityCount: allEntities.length }, 'export completed');
  } catch (error) {
    logger.error({ exportId, jobId, error }, 'export job failed');
    await deps.exportRepo.updateStatus(exportId, tenantId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }).catch((e: unknown) => {
      logger.error({ exportId, error: e }, 'failed to mark export as failed');
    });
  }
}
