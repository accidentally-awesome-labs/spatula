import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { Entity, EntityWithProvenance } from '@accidentally-awesome-labs/spatula-shared';

export class JsonExporter implements Exporter {
  readonly format = 'json' as const;

  async export(
    entities: unknown[],
    _schema: SchemaDefinition,
    options: ExportOptions,
  ): Promise<ExportResult> {
    const serialized = (entities as (Entity | EntityWithProvenance)[]).map((entity) => {
      const base: Record<string, unknown> = {
        data: entity.mergedData,
        qualityScore: entity.qualityScore,
        categories: entity.categories,
        sourceCount: entity.sourceCount,
      };
      if (options.includeProvenance && 'provenance' in entity) {
        const withProv = entity as EntityWithProvenance;
        base.provenance = withProv.provenance;
        base.sources = withProv.sources;
      }
      return base;
    });

    return {
      format: 'json',
      entityCount: entities.length,
      data: JSON.stringify(serialized, null, 2),
      generatedAt: new Date(),
    };
  }
}
