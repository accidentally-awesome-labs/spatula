import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';

interface EntityLike {
  mergedData: Record<string, unknown>;
  qualityScore?: number;
  categories?: string[];
  sourceCount?: number;
  provenance?: Record<string, unknown>;
  sources?: unknown[];
}

export class JsonExporter implements Exporter {
  readonly format = 'json' as const;

  async export(
    entities: unknown[],
    _schema: SchemaDefinition,
    options: ExportOptions,
  ): Promise<ExportResult> {
    const serialized = (entities as EntityLike[]).map((entity) => {
      const base: Record<string, unknown> = {
        data: entity.mergedData,
        qualityScore: entity.qualityScore,
        categories: entity.categories,
        sourceCount: entity.sourceCount,
      };
      if (options.includeProvenance && entity.provenance) {
        base.provenance = entity.provenance;
        base.sources = entity.sources;
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
