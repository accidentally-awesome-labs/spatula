import { z } from 'zod';
import { NormalizationRule } from './normalization.js';

// Recursive type needs explicit annotation; we use the 3-arg form of ZodType
// to account for .default() fields where Input !== Output.
export type FieldDefinitionOutput = {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'url' | 'currency' | 'enum' | 'array' | 'object';
  required: boolean;
  /** Maximum byte length for string field values. When set, StaticExtractor caps values here. Default: 2000 chars. */
  maxLength?: number;
  normalization?: z.infer<typeof NormalizationRule>;
  enumValues?: string[];
  arrayItemType?: FieldDefinitionOutput;
  objectFields?: FieldDefinitionOutput[];
};

export type FieldDefinitionInput = {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'url' | 'currency' | 'enum' | 'array' | 'object';
  required?: boolean;
  /** Maximum byte length for string field values. When set, StaticExtractor caps values here. Default: 2000 chars. */
  maxLength?: number;
  normalization?: z.input<typeof NormalizationRule>;
  enumValues?: string[];
  arrayItemType?: FieldDefinitionInput;
  objectFields?: FieldDefinitionInput[];
};

export const FieldDefinition: z.ZodType<FieldDefinitionOutput, z.ZodTypeDef, FieldDefinitionInput> =
  z.lazy(() =>
    z.object({
      name: z.string(),
      description: z.string(),
      type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
      required: z.boolean().default(false),
      maxLength: z.number().int().positive().optional(),
      normalization: NormalizationRule.optional(),
      enumValues: z.array(z.string()).optional(),
      arrayItemType: FieldDefinition.optional(),
      objectFields: z.array(FieldDefinition).optional(),
    }),
  );

export type FieldDefinition = z.infer<typeof FieldDefinition>;

// `FieldDef` / `FieldDefSchema` are the public surface names. Keep both for
// backward compatibility.
// `FieldDefinition` is the legacy in-tree name (used across @spatula/core).
export { FieldDefinition as FieldDefSchema };
export type FieldDef = FieldDefinition;

export const FieldRelevance = z.object({
  globalFrequency: z.number(),
  categoryBreakdown: z.array(
    z.object({
      category: z.string(),
      frequency: z.number(),
      sampleSize: z.number(),
    }),
  ),
  classification: z.enum([
    'universal_required',
    'universal_optional',
    'categorical_required',
    'categorical_optional',
    'rare',
  ]),
  applicableCategories: z.array(z.string()).nullable(),
});

export type FieldRelevance = z.infer<typeof FieldRelevance>;

export const FieldAlias = z.object({
  canonicalName: z.string(),
  aliases: z.array(
    z.object({
      name: z.string(),
      sources: z.array(z.string()),
      occurrences: z.number(),
    }),
  ),
  mergedAt: z.coerce.date(),
  reasoning: z.string(),
});

export type FieldAlias = z.infer<typeof FieldAlias>;

export const SchemaDefinition = z.object({
  version: z.number(),
  fields: z.array(FieldDefinition),
  fieldAliases: z.array(FieldAlias),
  createdAt: z.coerce.date(),
  parentVersion: z.number().nullable(),
});

export type SchemaDefinition = z.infer<typeof SchemaDefinition>;
