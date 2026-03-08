import type { ExtractionResult } from '../types/extraction.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { EntityMatch } from '../types/reconciliation.js';
import type { ReconciliationConfig } from '../types/job.js';
import type { PipelineAction } from '../types/actions.js';

export interface DataReconciler {
  reconcile(
    extractions: ExtractionResult[],
    schema: SchemaDefinition,
    config: ReconciliationConfig,
  ): Promise<{
    entities: EntityMatch[];
    actions: PipelineAction[];
  }>;
}
