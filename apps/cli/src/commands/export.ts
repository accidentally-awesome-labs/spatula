/**
 * `spatula export` — export entities from the local project database to a file.
 *
 * Uses exporter classes from @spatula/core directly (not the server-side
 * processExport orchestrator) so we avoid server-side dependencies.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type {
  Exporter,
  ExportFormat,
  ExportOptions,
  SchemaDefinition,
} from '@spatula/core';
import {
  JsonExporter,
  CsvExporter,
  SqliteExporter,
  ParquetExporter,
  DuckDBExporter,
} from '@spatula/core';
import type { Entity } from '@spatula/shared';

import { openLocalProject } from '../local-project.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_FORMATS: ExportFormat[] = ['json', 'csv', 'sqlite', 'parquet', 'duckdb'];
const BATCH_SIZE = 200;

const BINARY_FORMATS: Set<ExportFormat> = new Set(['sqlite', 'parquet', 'duckdb']);

// ---------------------------------------------------------------------------
// Helpers — exported for testability
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a supported export format.
 * Throws if the format is not one of: json, csv, sqlite, parquet, duckdb.
 */
export function validateFormat(format: string): ExportFormat {
  if (!VALID_FORMATS.includes(format as ExportFormat)) {
    throw new Error(
      `Unsupported export format "${format}". Valid formats: ${VALID_FORMATS.join(', ')}`,
    );
  }
  return format as ExportFormat;
}

/**
 * Resolve the output file path.
 * If the user provided an explicit path, return it as-is (resolved to absolute).
 * Otherwise generate a default under `.spatula/exports/<timestamp>.<format>`.
 */
export function resolveOutputPath(
  providedPath: string | undefined,
  format: ExportFormat,
  projectRoot: string,
): string {
  if (providedPath) {
    return resolve(providedPath);
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  return join(projectRoot, '.spatula', 'exports', `${timestamp}.${format}`);
}

// ---------------------------------------------------------------------------
// Exporter factory
// ---------------------------------------------------------------------------

export function createExporter(format: ExportFormat): Exporter {
  switch (format) {
    case 'json':
      return new JsonExporter();
    case 'csv':
      return new CsvExporter();
    case 'sqlite':
      return new SqliteExporter();
    case 'parquet':
      return new ParquetExporter();
    case 'duckdb':
      return new DuckDBExporter();
  }
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface ExportCommandOptions {
  format?: string;
  output?: string;
  includeProvenance?: boolean;
  minQuality?: number;
}

export async function runExportCommand(opts: ExportCommandOptions = {}): Promise<void> {
  // 1. Validate format
  const format = validateFormat(opts.format ?? 'json');

  // 2. Open local project
  const project = await openLocalProject(process.cwd());

  try {
    // 3. Get schema — required for export
    const schemaResult = (await project.dataSource.getSchema()) as {
      definition: SchemaDefinition;
    } | null;

    if (!schemaResult || !schemaResult.definition) {
      console.error(
        'No schema found. Run `spatula run` to crawl and build a schema first.',
      );
      process.exit(1);
    }

    const schema = schemaResult.definition;

    // 4. Batch-load all entities
    const allEntities: Entity[] = [];
    let offset = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await project.dataSource.getEntities({
        limit: BATCH_SIZE,
        offset,
      });

      allEntities.push(...page.data);

      if (allEntities.length >= page.total || page.data.length === 0) {
        break;
      }

      offset += BATCH_SIZE;
    }

    // 5. Apply min-quality filter
    let entities = allEntities;
    if (opts.minQuality !== undefined) {
      entities = entities.filter((e) => e.qualityScore >= opts.minQuality!);
    }

    if (entities.length === 0) {
      console.log('No entities match the given criteria. Nothing to export.');
      return;
    }

    // 6. Resolve output path
    const outputPath = resolveOutputPath(opts.output, format, project.projectRoot);

    // 7. Ensure output directory exists
    const outputDir = dirname(outputPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // 8. Run exporter
    const exporter = createExporter(format);
    const exportOptions: ExportOptions = {
      format,
      includeProvenance: opts.includeProvenance ?? false,
      includeDocumentation: false,
      outputPath,
    };

    const result = await exporter.export(entities, schema, exportOptions);

    // 9. Write output file
    if (result.filePath) {
      // Some exporters write directly to disk via outputPath
      // — nothing to write, just report the path
    } else if (BINARY_FORMATS.has(format)) {
      if (!result.binaryData) {
        console.error(`Exporter for "${format}" did not produce binary data.`);
        process.exit(1);
      }
      writeFileSync(outputPath, result.binaryData);
    } else {
      if (result.data === undefined || result.data === null) {
        console.error(`Exporter for "${format}" did not produce data.`);
        process.exit(1);
      }
      writeFileSync(outputPath, String(result.data), 'utf-8');
    }

    // 10. Show summary
    const finalPath = result.filePath ?? outputPath;
    const fileSize = statSync(finalPath).size;
    const sizeStr = formatFileSize(fileSize);

    console.log('');
    console.log('  Export complete');
    console.log('  ' + '-'.repeat(50));
    console.log(`  Entities : ${result.entityCount}`);
    console.log(`  Format   : ${format}`);
    console.log(`  File     : ${finalPath}`);
    console.log(`  Size     : ${sizeStr}`);
    console.log('');
  } finally {
    project.close();
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
