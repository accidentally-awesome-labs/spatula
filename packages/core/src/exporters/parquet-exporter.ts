import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';
import { mapSchema } from './column-mapper.js';

// Map column-mapper nativeType values to hyparquet-writer BasicType values
function toParquetType(nativeType: string): 'STRING' | 'DOUBLE' | 'BOOLEAN' {
  switch (nativeType) {
    case 'DOUBLE':
      return 'DOUBLE';
    case 'BOOLEAN':
      return 'BOOLEAN';
    default:
      // UTF8 and all other string-like types map to STRING
      return 'STRING';
  }
}

export class ParquetExporter implements Exporter {
  readonly format = 'parquet' as const;

  async export(
    entities: unknown[],
    schema: SchemaDefinition,
    _options: ExportOptions,
  ): Promise<ExportResult> {
    const columns = mapSchema(schema, 'parquet');

    // Build column-oriented data arrays
    const columnData = columns.map((col) => ({
      name: col.name,
      type: toParquetType(col.nativeType),
      nullable: col.nullable,
      data: entities.map((entity: unknown) => {
        const val = (((entity as Record<string, unknown>).mergedData as Record<string, unknown>) ??
          {})[col.name];
        if (val === undefined || val === null) return null;
        if (typeof val === 'object') return JSON.stringify(val);
        return val;
      }),
    }));

    // Use hyparquet-writer to create Parquet buffer
    const { parquetWriteBuffer } = await import('hyparquet-writer');
    const buffer = parquetWriteBuffer({ columnData });

    return {
      format: 'parquet',
      entityCount: entities.length,
      binaryData: new Uint8Array(buffer),
      generatedAt: new Date(),
    };
  }
}
