import type { ExtractionWithSource } from '../reconciliation/entity-matcher.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { EntityMatch } from '../types/reconciliation.js';
import type { ReconciliationConfig } from '../types/job.js';
import type { PipelineAction } from '../types/actions.js';

export interface DataReconciler {
  reconcile(
    extractions: ExtractionWithSource[],
    schema: SchemaDefinition,
    config: ReconciliationConfig,
    jobDescription: string,
  ): Promise<{
    entities: EntityMatch[];
    actions: PipelineAction[];
  }>;
}
