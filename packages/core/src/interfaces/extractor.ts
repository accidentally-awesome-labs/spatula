import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';

export interface Extractor {
  extract(
    html: string,
    url: string,
    schema: SchemaDefinition,
    jobDescription: string,
  ): Promise<ExtractionResult>;
}
