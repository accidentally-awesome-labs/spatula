import { z } from 'zod';
import type { SchemaDefinition } from '../types/schema.js';

export const ExportFormat = z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite']);
export type ExportFormat = z.infer<typeof ExportFormat>;

export const ExportOptions = z.object({
  format: ExportFormat,
  includeProvenance: z.boolean().default(false),
  includeDocumentation: z.boolean().default(true),
  outputPath: z.string().optional(),
});

export type ExportOptions = z.infer<typeof ExportOptions>;

export const ExportResult = z.object({
  format: ExportFormat,
  entityCount: z.number(),
  filePath: z.string().optional(),
  data: z.unknown().optional(),
  binaryData: z.instanceof(Uint8Array).optional(),
  generatedAt: z.coerce.date(),
});

export type ExportResult = z.infer<typeof ExportResult>;

export interface Exporter {
  readonly format: ExportFormat;
  export(
    entities: unknown[],
    schema: SchemaDefinition,
    options: ExportOptions,
  ): Promise<ExportResult>;
}
