import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { Entity } from '@accidentally-awesome-labs/spatula-shared';
import { entitiesToCsv } from './csv-utils.js';

export class CsvExporter implements Exporter {
  readonly format = 'csv' as const;

  async export(
    entities: unknown[],
    schema: SchemaDefinition,
    _options: ExportOptions,
  ): Promise<ExportResult> {
    const fields = schema.fields.map((f) => f.name);
    const csv = entitiesToCsv(entities as Entity[], fields);

    return {
      format: 'csv',
      entityCount: entities.length,
      data: csv,
      generatedAt: new Date(),
    };
  }
}
