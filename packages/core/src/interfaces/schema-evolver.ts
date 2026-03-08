import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import type { PipelineAction } from '../types/actions.js';

export interface SchemaEvolver {
  evolve(
    currentSchema: SchemaDefinition,
    recentExtractions: ExtractionResult[],
    jobDescription: string,
  ): Promise<PipelineAction[]>;
}
