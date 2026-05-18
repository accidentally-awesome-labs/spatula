import { createLogger, generateId } from '@spatula/shared';
import type { PipelineAction } from '../types/actions.js';
import type {
  ActionExecutor,
  ActionResult,
  ActionPreview,
  StateChange,
} from '../interfaces/action-executor.js';
import { resolvePolicy, shouldAutoApply, type ApprovalPreset } from './safety-policy.js';
import { applySchemaActions } from '../evolution/schema-action-applier.js';
import { applyCategoryActions } from './category-applier.js';
import { applyReconciliationAction, type ReconciliationDeps } from './reconciliation-applier.js';
import { applyFinalizationAction } from './finalization-applier.js';
import type { ReviewQueue } from './review-queue.js';
import type { SchemaDefinition } from '../types/schema.js';

const logger = createLogger('action-executor');

// --- Action type categories for domain dispatch ---

const SCHEMA_ACTIONS = new Set([
  'add_field',
  'remove_field',
  'modify_field',
  'rename_field',
  'merge_fields',
  'split_field',
  'group_fields',
  'set_normalization_rule',
  'update_enum_map',
]);

const CATEGORY_ACTIONS = new Set(['define_category', 'assign_category_fields']);

const CRAWL_ACTIONS = new Set(['classify_page', 'enqueue_links', 'hint_entity_match']);

const RECONCILIATION_ACTIONS = new Set([
  'resolve_conflict',
  'infer_value',
  'correct_value',
  'match_entities',
  'split_entities',
  'set_source_trust',
]);

const REPROCESSING_ACTIONS = new Set(['reprocess_extraction']);

const FINALIZATION_ACTIONS = new Set([
  'recommend_table_structure',
  'derive_field',
  'flag_anomaly',
  'generate_documentation',
]);

// --- Risk level assessment ---

const HIGH_RISK_ACTIONS = new Set(['remove_field', 'split_entities']);
const MEDIUM_RISK_ACTIONS = new Set([
  'merge_fields',
  'split_field',
  'group_fields',
  'resolve_conflict',
  'correct_value',
]);

function assessRiskLevel(action: PipelineAction): 'low' | 'medium' | 'high' {
  if (HIGH_RISK_ACTIONS.has(action.type)) return 'high';
  if (MEDIUM_RISK_ACTIONS.has(action.type)) return 'medium';
  return 'low';
}

// --- Interfaces for executor dependencies ---

export interface ActionExecutorActionRepo {
  create(input: {
    jobId: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
    source: string;
    status: string;
    confidence: number;
    reasoning: string;
    stateChanges?: Record<string, unknown>;
  }): Promise<{ id: string }>;

  findById(
    actionId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    type: string;
    status: string;
    [key: string]: unknown;
  } | null>;

  updateStatus(
    actionId: string,
    tenantId: string,
    status: string,
    reviewedBy?: string,
  ): Promise<unknown>;
}

export interface ActionExecutorSchemaRepo {
  findLatest(
    jobId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    version: number;
    definition: SchemaDefinition;
  } | null>;

  create(input: {
    jobId: string;
    tenantId: string;
    version: number;
    definition: SchemaDefinition;
    parentVersion: number | null;
  }): Promise<{ id: string }>;
}

export interface ActionExecutorConfig {
  actionRepo: ActionExecutorActionRepo;
  schemaRepo: ActionExecutorSchemaRepo;
  entityRepo: ReconciliationDeps['entityRepo'];
  entitySourceRepo: ReconciliationDeps['entitySourceRepo'];
  sourceTrustRepo: ReconciliationDeps['sourceTrustRepo'];
  reviewQueue: ReviewQueue;
  approvalPreset: ApprovalPreset;
  confidenceThreshold: number;
  tenantId: string;
}

export class DefaultActionExecutor implements ActionExecutor {
  private readonly config: ActionExecutorConfig;

  constructor(config: ActionExecutorConfig) {
    this.config = config;
  }

  async execute(action: PipelineAction): Promise<ActionResult> {
    const { approvalPreset, confidenceThreshold, reviewQueue, tenantId } = this.config;

    const policy = resolvePolicy(action.type, approvalPreset);
    const autoApply = shouldAutoApply(policy, action.confidence, confidenceThreshold);

    logger.debug(
      { type: action.type, policy, autoApply, confidence: action.confidence },
      'executing action',
    );

    if (!autoApply) {
      // Defer to review queue
      const preview = await this.preview(action);
      await reviewQueue.enqueue(action, tenantId, preview);

      return {
        actionId: generateId(),
        status: 'deferred',
        stateChanges: [],
      };
    }

    // Auto-apply: dispatch to domain applier
    const stateChanges = await this.applyAction(action);

    // Persist action record with 'applied' status
    const payload = 'payload' in action ? (action as any).payload : {};
    const record = await this.config.actionRepo.create({
      jobId: action.jobId,
      tenantId,
      type: action.type,
      payload,
      source: action.source,
      status: 'applied',
      confidence: action.confidence,
      reasoning: action.reasoning,
      ...(stateChanges.length > 0 ? { stateChanges: { changes: stateChanges } } : {}),
    });

    return {
      actionId: record.id,
      status: 'applied',
      stateChanges,
    };
  }

  async preview(action: PipelineAction): Promise<ActionPreview> {
    const { approvalPreset, confidenceThreshold } = this.config;

    const policy = resolvePolicy(action.type, approvalPreset);
    const autoApply = shouldAutoApply(policy, action.confidence, confidenceThreshold);

    return {
      actionId: generateId(),
      wouldChange: [],
      riskLevel: assessRiskLevel(action),
      requiresApproval: !autoApply,
    };
  }

  async rollback(actionId: string): Promise<void> {
    const { actionRepo, tenantId } = this.config;

    const action = await actionRepo.findById(actionId, tenantId);
    if (!action) {
      throw new Error(`Action ${actionId} not found`);
    }

    if (action.status !== 'applied') {
      throw new Error(`Action ${actionId} not applied — cannot rollback`);
    }

    // Reconciliation rollback not supported in v1
    if (RECONCILIATION_ACTIONS.has(action.type)) {
      throw new Error(`Rollback of reconciliation action ${action.type} not supported in v1`);
    }

    await actionRepo.updateStatus(actionId, tenantId, 'rolled_back');

    logger.debug({ actionId, type: action.type }, 'action rolled back');
  }

  // --- Domain dispatch ---

  private async applyAction(action: PipelineAction): Promise<StateChange[]> {
    const actionType = action.type;

    if (SCHEMA_ACTIONS.has(actionType)) {
      return this.applySchemaAction(action);
    }

    if (CATEGORY_ACTIONS.has(actionType)) {
      return this.applyCategoryAction(action);
    }

    if (CRAWL_ACTIONS.has(actionType)) {
      // No-ops at execution time — produced inline by workers
      logger.debug({ type: actionType }, 'crawl action (no-op at execution)');
      return [];
    }

    if (RECONCILIATION_ACTIONS.has(actionType)) {
      return this.applyReconciliation(action);
    }

    if (REPROCESSING_ACTIONS.has(actionType)) {
      // No-op for now
      logger.debug({ type: actionType }, 'reprocessing action (no-op for now)');
      return [];
    }

    if (FINALIZATION_ACTIONS.has(actionType)) {
      return this.applyFinalization(action);
    }

    logger.warn({ type: actionType }, 'unknown action type — treating as no-op');
    return [];
  }

  private async applySchemaAction(action: PipelineAction): Promise<StateChange[]> {
    const { schemaRepo, tenantId } = this.config;

    const latestSchema = await schemaRepo.findLatest(action.jobId, tenantId);
    if (!latestSchema) {
      logger.warn({ jobId: action.jobId }, 'no schema found for job — skipping schema action');
      return [];
    }

    const before = latestSchema.definition;
    const after = applySchemaActions(before, [action]);

    // If version changed, persist the new schema
    if (after.version !== before.version) {
      await schemaRepo.create({
        jobId: action.jobId,
        tenantId,
        version: after.version,
        definition: after,
        parentVersion: before.version,
      });

      logger.debug(
        { jobId: action.jobId, oldVersion: before.version, newVersion: after.version },
        'new schema version created',
      );

      return [
        {
          path: 'schema.version',
          before: before.version,
          after: after.version,
        },
        {
          path: 'schema.fields',
          before: before.fields,
          after: after.fields,
        },
      ];
    }

    return [];
  }

  private applyCategoryAction(action: PipelineAction): StateChange[] {
    // applyCategoryActions expects an array; we always pass single actions here
    const result = applyCategoryActions(
      // Category applier needs a schema but only uses it for reference —
      // we pass a minimal schema since category actions don't modify it
      { version: 0, fields: [], fieldAliases: [], createdAt: new Date(), parentVersion: null },
      [action],
    );

    const stateChanges: StateChange[] = [];

    if (result.categories) {
      stateChanges.push({
        path: 'categories',
        before: undefined,
        after: result.categories,
      });
    }

    if (result.categoryFieldAssignments) {
      stateChanges.push({
        path: 'categoryFieldAssignments',
        before: undefined,
        after: result.categoryFieldAssignments,
      });
    }

    return stateChanges;
  }

  private async applyReconciliation(action: PipelineAction): Promise<StateChange[]> {
    const { entityRepo, entitySourceRepo, sourceTrustRepo, tenantId } = this.config;

    const result = await applyReconciliationAction(action, tenantId, {
      entityRepo,
      entitySourceRepo,
      sourceTrustRepo,
    });

    if (!result.applied) {
      logger.warn(
        { type: action.type, reason: result.reason },
        'reconciliation action not applied',
      );
    }

    return result.stateChanges ?? [];
  }

  private applyFinalization(action: PipelineAction): StateChange[] {
    const result = applyFinalizationAction(action);

    if (!result.applied) {
      logger.warn({ type: action.type, reason: result.reason }, 'finalization action not applied');
      return [];
    }

    if (result.metadata) {
      return [
        {
          path: `finalization.${action.type}`,
          before: undefined,
          after: result.metadata,
        },
      ];
    }

    return [];
  }
}
