import type { SchemaDefinition } from '../types/schema.js';
import type { Entity } from '@accidentally-awesome-labs/spatula-shared';
import type { DataDictionary, FieldDocumentation, FieldStats } from './types.js';

const MAX_SAMPLE_ENTITIES = 1000;
const MAX_UNIQUE_TRACK = 1000;
const MAX_SAMPLE_VALUES = 5;

export function generateDocumentation(
  schema: SchemaDefinition,
  entities: Entity[],
  jobId: string,
): DataDictionary {
  const sampled = entities.length > MAX_SAMPLE_ENTITIES;
  const sampleEntities = sampled ? entities.slice(0, MAX_SAMPLE_ENTITIES) : entities;
  const totalCount = sampleEntities.length;

  const aliasMap = new Map<string, string[]>();
  for (const alias of schema.fieldAliases) {
    aliasMap.set(
      alias.canonicalName,
      alias.aliases.map((a) => a.name),
    );
  }

  const fields: FieldDocumentation[] = schema.fields.map((field) => {
    const stats = computeFieldStats(field.name, field.type, sampleEntities, totalCount);
    return {
      name: field.name,
      type: field.type,
      description: field.description,
      required: field.required,
      aliases: aliasMap.get(field.name) ?? [],
      stats,
    };
  });

  return {
    jobId,
    schemaVersion: schema.version,
    generatedAt: new Date().toISOString(),
    entityCount: entities.length,
    ...(sampled ? { sampled: true, sampleSize: MAX_SAMPLE_ENTITIES } : {}),
    fields,
  };
}

function computeFieldStats(
  fieldName: string,
  fieldType: string,
  entities: Entity[],
  totalCount: number,
): FieldStats {
  let nonNullCount = 0;
  const uniqueValues = new Set<string>();
  const sampleValues: unknown[] = [];
  let min: number | undefined;
  let max: number | undefined;
  const isNumeric = fieldType === 'number' || fieldType === 'currency';

  for (const entity of entities) {
    const val = entity.mergedData[fieldName];
    if (val === null || val === undefined) continue;
    nonNullCount++;
    const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (uniqueValues.size < MAX_UNIQUE_TRACK) uniqueValues.add(strVal);
    if (sampleValues.length < MAX_SAMPLE_VALUES && !sampleValues.includes(val))
      sampleValues.push(val);
    if (isNumeric && typeof val === 'number') {
      if (min === undefined || val < min) min = val;
      if (max === undefined || val > max) max = val;
    }
  }

  return {
    fillRate: totalCount === 0 ? 0 : nonNullCount / totalCount,
    uniqueCount: uniqueValues.size,
    sampleValues,
    ...(isNumeric && min !== undefined ? { min, max } : {}),
  };
}
