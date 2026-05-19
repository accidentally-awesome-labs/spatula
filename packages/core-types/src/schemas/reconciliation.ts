import { z } from 'zod';
import { ValueProvenance } from './extraction.js';
import { ConflictResolution } from './job.js';

export const TrustLevel = z.enum(['authoritative', 'high', 'medium', 'low']);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const SourceTrust = z.object({
  domain: z.string(),
  trustLevel: TrustLevel,
  reasoning: z.string(),
});

export type SourceTrust = z.infer<typeof SourceTrust>;

export const FieldProvenanceEntry = z.object({
  finalValue: z.unknown(),
  provenanceType: ValueProvenance,
  sources: z.array(
    z.object({
      sourceUrl: z.string(),
      rawValue: z.unknown(),
      normalizedValue: z.unknown(),
    }),
  ),
  hadConflict: z.boolean(),
  resolution: ConflictResolution.optional(),
});

export type FieldProvenanceEntry = z.infer<typeof FieldProvenanceEntry>;

export const EntityMatch = z.object({
  entityId: z.string().uuid(),
  sourceExtractions: z.array(
    z.object({
      extractionId: z.string().uuid(),
      sourceUrl: z.string().url(),
      sourceDomain: z.string(),
      crawledAt: z.coerce.date(),
      fieldsCovered: z.array(z.string()),
    }),
  ),
  mergedData: z.record(z.unknown()),
  fieldProvenance: z.record(FieldProvenanceEntry),
});

export type EntityMatch = z.infer<typeof EntityMatch>;
