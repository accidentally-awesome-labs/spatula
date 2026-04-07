// packages/core/src/pipeline/export-orchestrator.ts
import { createLoggerWithContext, StorageError, ValidationError } from '@spatula/shared';
import type { Entity } from '@spatula/shared';
import { CsvExporter } from '../exporters/csv-exporter.js';
import { JsonExporter } from '../exporters/json-exporter.js';
import { SqliteExporter } from '../exporters/sqlite-exporter.js';
import { ParquetExporter } from '../exporters/parquet-exporter.js';
import { DuckDBExporter } from '../exporters/duckdb-exporter.js';
import { StreamingJsonExporter } from '../exporters/streaming-json-exporter.js';
import { StreamingCsvExporter } from '../exporters/streaming-csv-exporter.js';
import { generateDocumentation } from '../exporters/documentation-generator.js';
import { fetchEntitiesCursor } from './entity-cursor.js';
import type { Exporter, ExportFormat, ExportOptions, SchemaDefinition } from '../index.js';
import type {
  ExportOrchestratorDeps,
  ExportInput,
  PipelineExportResult,
} from './types.js';

const MAX_EXPORT_ENTITIES = 50_000;

function getExporter(format: string): Exporter {
  switch (format) {
    case 'json': return new JsonExporter();
    case 'csv': return new CsvExporter();
    case 'sqlite': return new SqliteExporter();
    case 'parquet': return new ParquetExporter();
    case 'duckdb': return new DuckDBExporter();
    default: throw new ValidationError(`Unsupported export format: ${format}`);
  }
}

/**
 * Pure export logic. No BullMQ/Redis references.
 *
 * Validates job status, fetches schema + entities, runs exporter,
 * stores result, and updates export status.
 */
export async function processExport(
  input: ExportInput,
  deps: ExportOrchestratorDeps,
): Promise<PipelineExportResult> {
  const { exportId, jobId, tenantId, format, includeProvenance } = input;
  const logger = createLoggerWithContext('export-orchestrator', { jobId, tenantId });

  try {
    // 0. Verify job exists and is in a completed state
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      throw new StorageError('Job not found', { context: { exportId, jobId } });
    }
    const jobStatus = (job as { status?: string }).status;
    if (jobStatus !== 'completed') {
      throw new ValidationError(`Job is not completed (status: ${jobStatus}). Export requires a completed job.`, { context: { exportId, jobId, status: jobStatus } });
    }

    // 1. Mark as processing
    await deps.exportRepo.updateStatus(exportId, tenantId, { status: 'processing' });

    // 2. Fetch schema
    const schemaRow = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schemaRow) {
      throw new StorageError('No schema found for job', { context: { exportId, jobId } });
    }
    const schema = schemaRow.definition as SchemaDefinition;

    // 3. Determine export strategy
    const useProvenance = includeProvenance && format === 'json';
    const streamingFormats = new Set(['json', 'csv']);
    const canStream = streamingFormats.has(format) && !useProvenance && typeof deps.entityRepo.findByJobCursor === 'function';

    let allEntities: Entity[] = [];
    let contentToStore: string | undefined;
    let binaryToStore: Uint8Array | undefined;
    let entityCount = 0;

    // Entity count guard (applies to ALL paths)
    const total = await deps.entityRepo.countByJob(jobId, tenantId);
    const maxEntities = input.maxEntities ?? MAX_EXPORT_ENTITIES;
    if (total > maxEntities) {
      throw new ValidationError(
        `Export too large: ${total} entities exceeds maximum of ${maxEntities.toLocaleString()}. Consider filtering first.`,
        { context: { exportId, jobId, total, max: maxEntities } },
      );
    }

    if (canStream) {
      // STREAMING PATH: JSON/CSV without provenance
      let streamEntityCount = 0;

      // Count entities as they stream through
      async function* countedEntityStream() {
        for await (const batch of fetchEntitiesCursor(deps.entityRepo as any, jobId, tenantId, 500, { minQuality: input.minQuality })) {
          streamEntityCount += batch.length;
          yield batch;
        }
      }

      // Apply field projection if requested
      async function* projectedStream() {
        for await (const batch of countedEntityStream()) {
          if (input.fields) {
            yield batch.map((entity: any) => ({
              ...entity,
              mergedData: Object.fromEntries(
                input.fields!.map((f) => [f, (entity.mergedData ?? entity)[f]]),
              ),
            }));
          } else {
            yield batch;
          }
        }
      }
      const entityStream = projectedStream();
      const streamExporter = format === 'json'
        ? new StreamingJsonExporter()
        : new StreamingCsvExporter();
      const outputStream = streamExporter.export(entityStream);

      // Collect stream to string
      const reader = outputStream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const rawContent = new TextDecoder().decode(Buffer.concat(chunks));

      if (format === 'json') {
        // Wrap in envelope (same structure as non-streaming path)
        const entitiesArray = JSON.parse(rawContent);
        entityCount = streamEntityCount;
        const documentation = generateDocumentation(schema, entitiesArray as Entity[], jobId);
        const envelope = {
          metadata: {
            jobId,
            exportedAt: new Date().toISOString(),
            entityCount,
            schemaVersion: schema.version,
            format: 'json',
            includeProvenance: false,
          },
          schema,
          documentation,
          entities: entitiesArray,
        };
        contentToStore = JSON.stringify(envelope, null, 2);
      } else {
        // CSV — count from cursor iteration (not line-splitting, which overcounts for embedded newlines)
        contentToStore = rawContent;
        entityCount = streamEntityCount;
      }
    } else {
      // OFFSET/BINARY PATH: binary formats, provenance, or no cursor support
      // Fetch via cursor if available (and not provenance), otherwise offset
      if (typeof deps.entityRepo.findByJobCursor === 'function' && !useProvenance) {
        for await (const batch of fetchEntitiesCursor(deps.entityRepo as any, jobId, tenantId, 500, { minQuality: input.minQuality })) {
          allEntities.push(...(batch as Entity[]));
        }
      } else {
        let offset = 0;
        while (offset < total) {
          const batch = useProvenance
            ? await deps.entityRepo.findByJobWithProvenance(jobId, tenantId, { limit: 100, offset })
            : await deps.entityRepo.findByJob(jobId, tenantId, { limit: 100, offset });
          allEntities.push(...(batch as unknown as Entity[]));
          offset += 100;
        }
        // Apply minQuality filter for offset path (cursor path handles it at DB level)
        if (input.minQuality !== undefined) {
          allEntities = allEntities.filter((e: any) => (e.qualityScore ?? 0) >= input.minQuality!);
        }
      }
      // Apply field projection if requested
      if (input.fields) {
        allEntities = allEntities.map((entity: any) => ({
          ...entity,
          mergedData: Object.fromEntries(
            input.fields!.map((f) => [f, (entity.mergedData ?? entity)[f]]),
          ),
        }));
      }
      entityCount = allEntities.length;

      // Run existing exporter for this path
      const documentation = format === 'json'
        ? generateDocumentation(schema, allEntities, jobId)
        : null;
      const exporter = getExporter(format);
      const result = await exporter.export(allEntities, schema, {
        format: format as ExportFormat,
        includeProvenance,
        includeDocumentation: format === 'json',
      } as ExportOptions);

      if (result.binaryData) {
        binaryToStore = result.binaryData;
      } else {
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
          contentToStore = JSON.stringify(envelope, null, 2);
        } else {
          contentToStore = result.data as string;
        }
      }
    }

    // 6. Store result (unified for both paths)
    const key = `exports/${tenantId}/${jobId}/${exportId}.${format}`;
    let contentRef: string;
    let fileSize: number;

    if (binaryToStore) {
      contentRef = await deps.contentStore.storeBinary(key, binaryToStore);
      fileSize = binaryToStore.byteLength;
    } else {
      contentRef = await deps.contentStore.store(key, contentToStore!);
      fileSize = Buffer.byteLength(contentToStore!, 'utf-8');
    }

    // 6b. Record storage usage for billing metering
    if (deps.quotaEnforcer) {
      deps.quotaEnforcer.recordUsage(tenantId, 'storage_bytes', fileSize).catch((err: unknown) => {
        logger.warn({ err, tenantId, fileSize }, 'Failed to record storage usage for billing');
      });
    }

    // 7. Mark as completed
    await deps.exportRepo.updateStatus(exportId, tenantId, {
      status: 'completed',
      entityCount,
      contentRef,
      fileSize,
      completedAt: new Date(),
    });

    logger.info({ exportId, jobId, format, entityCount }, 'export completed');

    return {
      entityCount,
      fileSize,
      contentRef,
    };
  } catch (error) {
    logger.error({ exportId, jobId, error }, 'export failed');
    await deps.exportRepo.updateStatus(exportId, tenantId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }).catch((e: unknown) => {
      logger.error({ exportId, error: e }, 'failed to mark export as failed');
    });
    // Return a zero-result to indicate failure without throwing
    return { entityCount: 0, fileSize: 0, contentRef: '' };
  }
}
