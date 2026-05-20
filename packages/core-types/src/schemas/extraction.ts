import { z } from 'zod';

/**
 * Scan flag shape — matches ScanFlag in packages/core/src/extraction/output-scanner.ts.
 * Duplicated here (rather than importing from core) to keep core-types dependency-free.
 */
const ScanFlagSchema = z.object({
  kind: z.enum(['prompt_echo', 'field_name_leak', 'cap_hit']),
  field: z.string().optional(),
  detail: z.string(),
});

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
  /** Prompt-injection scan result (SEC-01 mitigation 7). Present when StaticExtractor ran scanOutput. */
  suspicious: z.boolean().optional(),
  /** Individual scan flags explaining why suspicious=true. */
  scanFlags: z.array(ScanFlagSchema).optional(),
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

// Plan-16-2 alias (public SDK surface name).
export { ExtractionResult as ExtractionResultSchema };

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
