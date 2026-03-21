import { createLoggerWithContext, QueueError, ValidationError } from '@spatula/shared';
import { CsvExporter, JsonExporter, SqliteExporter, ParquetExporter, DuckDBExporter, generateDocumentation } from '@spatula/core';
import type { Exporter, SchemaDefinition } from '@spatula/core';
import type { Entity } from '@spatula/shared';
import type { ExportJobPayload } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

function getExporter(format: string): Exporter {
  switch (format) {
    case 'json': return new JsonExporter();
    case 'csv': return new CsvExporter();
    case 'sqlite': return new SqliteExporter();
    case 'parquet': return new ParquetExporter();
    case 'duckdb': return new DuckDBExporter();
    default: throw new QueueError(`Unsupported export format: ${format}`);
  }
}

export async function processExportJob(
  data: ExportJobPayload,
  deps: WorkerDeps,
): Promise<void> {
  const logger = createLoggerWithContext('export-worker', { jobId: data.jobId, tenantId: data.tenantId });
  const { exportId, jobId, tenantId, format, includeProvenance } = data;

  try {
    // 0. Verify job exists and is in a completed state
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      throw new QueueError('Job not found', { context: { exportId, jobId } });
    }
    const jobStatus = (job as { status?: string }).status;
    if (jobStatus !== 'completed') {
      throw new QueueError(`Job is not completed (status: ${jobStatus}). Export requires a completed job.`, { context: { exportId, jobId, status: jobStatus } });
    }

    // 1. Mark as processing
    await deps.exportRepo.updateStatus(exportId, tenantId, { status: 'processing' });

    // 2. Fetch schema
    const schemaRow = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schemaRow) {
      throw new QueueError('No schema found for job', { context: { exportId, jobId } });
    }
    const schema = schemaRow.definition as SchemaDefinition;

    // 3. Fetch all entities in batches
    const allEntities: Entity[] = [];
    const total = await deps.entityRepo.countByJob(jobId, tenantId);

    const MAX_EXPORT_ENTITIES = 50_000;
    if (total > MAX_EXPORT_ENTITIES) {
      throw new ValidationError(`Export too large: ${total} entities exceeds maximum of ${MAX_EXPORT_ENTITIES}. Consider filtering first.`, { context: { exportId, jobId, total, max: MAX_EXPORT_ENTITIES } });
    }
    let offset = 0;
    const useProvenance = includeProvenance && format === 'json';
    while (offset < total) {
      const batch = useProvenance
        ? await deps.entityRepo.findByJobWithProvenance(jobId, tenantId, { limit: 100, offset })
        : await deps.entityRepo.findByJob(jobId, tenantId, { limit: 100, offset });
      allEntities.push(...(batch as unknown as Entity[]));
      offset += 100;
    }

    // 4. Generate documentation (for JSON)
    const documentation = format === 'json'
      ? generateDocumentation(schema, allEntities, jobId)
      : null;

    // 5. Run exporter
    const exporter = getExporter(format);
    const result = await exporter.export(allEntities, schema, {
      format: format as any,
      includeProvenance,
      includeDocumentation: format === 'json',
    });

    // 6. Store result
    const key = `exports/${tenantId}/${jobId}/${exportId}.${format}`;
    let contentRef: string;
    let fileSize: number;

    if (result.binaryData) {
      // Binary formats (parquet, duckdb, sqlite)
      contentRef = await deps.contentStore.storeBinary(key, result.binaryData);
      fileSize = result.binaryData.byteLength;
    } else {
      // Text formats (json, csv)
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
      contentRef = await deps.contentStore.store(key, content);
      fileSize = Buffer.byteLength(content, 'utf-8');
    }

    // 7. Mark as completed
    await deps.exportRepo.updateStatus(exportId, tenantId, {
      status: 'completed',
      entityCount: allEntities.length,
      contentRef,
      fileSize,
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
