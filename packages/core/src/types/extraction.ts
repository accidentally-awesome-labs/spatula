import { z } from 'zod';

export const UnmappedField = z.object({
  name: z.string(),
  value: z.unknown(),
  suggestedType: z.string(),
});

export type UnmappedField = z.infer<typeof UnmappedField>;

export const ExtractionMetadata = z.object({
  confidence: z.number().min(0).max(1),
  modelUsed: z.string(),
  tokensUsed: z.number(),
  extractionTimeMs: z.number(),
  unmappedFields: z.array(UnmappedField),
});

export type ExtractionMetadata = z.infer<typeof ExtractionMetadata>;

export const ExtractionResult = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  pageId: z.string().uuid(),
  schemaVersion: z.number(),
  data: z.record(z.unknown()),
  metadata: ExtractionMetadata,
});

export type ExtractionResult = z.infer<typeof ExtractionResult>;

export const ValueProvenance = z.enum([
  'extracted',
  'normalized',
  'merged',
  'resolved',
  'inferred',
]);

export type ValueProvenance = z.infer<typeof ValueProvenance>;

export const PageClassification = z.enum([
  'single_entry',
  'multiple_entries',
  'navigation',
  'irrelevant',
  'partial',
]);

export type PageClassification = z.infer<typeof PageClassification>;

export const ExtractionStrategy = z.enum([
  'full_extraction',
  'list_extraction',
  'links_only',
  'skip',
]);

export type ExtractionStrategy = z.infer<typeof ExtractionStrategy>;
