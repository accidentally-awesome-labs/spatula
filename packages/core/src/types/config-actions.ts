import { z } from 'zod';
import { FieldDefinition } from './schema.js';

const BaseConfigAction = z.object({
  id: z.string().uuid(),
  reasoning: z.string(),
});

// --- Metadata ---

const SetJobNameAction = BaseConfigAction.extend({
  type: z.literal('set_job_name'),
  payload: z.object({ name: z.string() }),
});

const SetJobDescriptionAction = BaseConfigAction.extend({
  type: z.literal('set_job_description'),
  payload: z.object({ description: z.string() }),
});

// --- Seed URLs ---

const AddSeedUrlsAction = BaseConfigAction.extend({
  type: z.literal('add_seed_urls'),
  payload: z.object({
    urls: z.array(
      z.object({
        url: z.string().url(),
        label: z.string().optional(),
      }),
    ),
  }),
});

const RemoveSeedUrlsAction = BaseConfigAction.extend({
  type: z.literal('remove_seed_urls'),
  payload: z.object({
    urls: z.array(z.string().url()),
    reason: z.string().optional(),
  }),
});

const ReplaceSeedUrlsAction = BaseConfigAction.extend({
  type: z.literal('replace_seed_urls'),
  payload: z.object({
    urls: z.array(
      z.object({
        url: z.string().url(),
        label: z.string().optional(),
      }),
    ),
  }),
});

// --- Crawl Settings ---

const SetCrawlDepthAction = BaseConfigAction.extend({
  type: z.literal('set_crawl_depth'),
  payload: z.object({ maxDepth: z.number().min(0).max(10) }),
});

const SetMaxPagesAction = BaseConfigAction.extend({
  type: z.literal('set_max_pages'),
  payload: z.object({ maxPages: z.number().min(1) }),
});

const SetConcurrencyAction = BaseConfigAction.extend({
  type: z.literal('set_concurrency'),
  payload: z.object({ concurrency: z.number().min(1).max(20) }),
});

const SetCrawlerTypeAction = BaseConfigAction.extend({
  type: z.literal('set_crawler_type'),
  payload: z.object({
    crawlerType: z.enum(['playwright', 'firecrawl']),
    reason: z.string().optional(),
  }),
});

// --- Schema Fields ---

const AddUserFieldAction = BaseConfigAction.extend({
  type: z.literal('add_user_field'),
  payload: z.object({
    field: FieldDefinition,
    position: z.enum(['first', 'last', 'after']).default('last'),
    afterField: z.string().optional(),
  }),
});

const AddMultipleUserFieldsAction = BaseConfigAction.extend({
  type: z.literal('add_multiple_user_fields'),
  payload: z.object({
    fields: z.array(FieldDefinition),
  }),
});

const RemoveUserFieldAction = BaseConfigAction.extend({
  type: z.literal('remove_user_field'),
  payload: z.object({ fieldName: z.string() }),
});

const ModifyUserFieldAction = BaseConfigAction.extend({
  type: z.literal('modify_user_field'),
  payload: z.object({
    fieldName: z.string(),
    changes: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      type: z
        .enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object'])
        .optional(),
      required: z.boolean().optional(),
      enumValues: z.array(z.string()).optional(),
      arrayItemType: FieldDefinition.optional(),
      objectFields: z.array(FieldDefinition).optional(),
    }),
  }),
});

const ReorderUserFieldsAction = BaseConfigAction.extend({
  type: z.literal('reorder_user_fields'),
  payload: z.object({
    fieldOrder: z.array(z.string()),
  }),
});

const ReplaceAllUserFieldsAction = BaseConfigAction.extend({
  type: z.literal('replace_all_user_fields'),
  payload: z.object({
    fields: z.array(FieldDefinition),
  }),
});

const DefineNestedFieldAction = BaseConfigAction.extend({
  type: z.literal('define_nested_field'),
  payload: z.object({
    parentFieldName: z.string(),
    subFields: z.array(FieldDefinition),
  }),
});

// --- Schema Mode ---

const SetSchemaModeAction = BaseConfigAction.extend({
  type: z.literal('set_schema_mode'),
  payload: z.object({
    mode: z.enum(['fixed', 'discovery', 'hybrid']),
  }),
});

const SetEvolutionConfigAction = BaseConfigAction.extend({
  type: z.literal('set_evolution_config'),
  payload: z.object({
    enabled: z.boolean().optional(),
    batchSize: z.number().optional(),
    maxFields: z.number().optional(),
    relevanceThresholds: z
      .object({
        requiredMin: z.number().optional(),
        optionalMin: z.number().optional(),
        rareBelow: z.number().optional(),
        minCategorySampleSize: z.number().optional(),
      })
      .optional(),
    tableStrategy: z.enum(['single', 'multi', 'auto']).optional(),
  }),
});

// --- LLM Config ---

const LLMTask = z.enum([
  'pageRelevance',
  'extraction',
  'linkEvaluation',
  'schemaEvolution',
  'entityMatching',
  'conflictResolution',
  'qualityAudit',
  'documentation',
]);

const SetPrimaryModelAction = BaseConfigAction.extend({
  type: z.literal('set_primary_model'),
  payload: z.object({ model: z.string() }),
});

const SetModelOverrideAction = BaseConfigAction.extend({
  type: z.literal('set_model_override'),
  payload: z.object({ task: LLMTask, model: z.string() }),
});

const ClearModelOverrideAction = BaseConfigAction.extend({
  type: z.literal('clear_model_override'),
  payload: z.object({ task: LLMTask }),
});

// --- Reconciliation Config ---

const SetMatchStrategyAction = BaseConfigAction.extend({
  type: z.literal('set_match_strategy'),
  payload: z.object({
    matchStrategy: z.enum(['exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted']),
    fuzzyMatchThreshold: z.number().optional(),
    enableLLMMatching: z.boolean().optional(),
  }),
});

const SetConflictResolutionAction = BaseConfigAction.extend({
  type: z.literal('set_conflict_resolution'),
  payload: z.object({
    strategy: z.enum([
      'most_common',
      'most_complete',
      'source_priority',
      'most_recent',
      'llm_resolved',
    ]),
  }),
});

const SetSourcePriorityAction = BaseConfigAction.extend({
  type: z.literal('set_source_priority'),
  payload: z.object({
    rankings: z.array(
      z.object({
        domain: z.string(),
        trustLevel: z.enum(['authoritative', 'high', 'medium', 'low']),
        reasoning: z.string().optional(),
      }),
    ),
  }),
});

// --- Safety ---

const SetActionApprovalPolicyAction = BaseConfigAction.extend({
  type: z.literal('set_action_approval_policy'),
  payload: z.object({
    preset: z.enum(['trust_ai', 'balanced', 'cautious', 'manual']).optional(),
    overrides: z
      .array(
        z.object({
          actionType: z.string(),
          policy: z.enum(['always_auto', 'auto_above_threshold', 'always_review', 'batch_review']),
          threshold: z.number().optional(),
        }),
      )
      .optional(),
  }),
});

// --- Templates ---

const SaveAsTemplateAction = BaseConfigAction.extend({
  type: z.literal('save_as_template'),
  payload: z.object({
    templateName: z.string(),
    description: z.string().optional(),
  }),
});

const LoadTemplateAction = BaseConfigAction.extend({
  type: z.literal('load_template'),
  payload: z.object({
    templateName: z.string(),
    overrides: z.record(z.unknown()).optional(),
  }),
});

const CloneJobConfigAction = BaseConfigAction.extend({
  type: z.literal('clone_job_config'),
  payload: z.object({
    sourceJobId: z.string().uuid(),
    overrides: z.record(z.unknown()).optional(),
  }),
});

// --- Control ---

const ConfirmAndStartAction = BaseConfigAction.extend({
  type: z.literal('confirm_and_start'),
  payload: z.object({}),
});

const ResetConfigAction = BaseConfigAction.extend({
  type: z.literal('reset_config'),
  payload: z.object({
    keepFields: z
      .array(
        z.enum(['name', 'description', 'seedUrls', 'userFields', 'crawlSettings', 'llmConfig']),
      )
      .optional(),
  }),
});

// --- Union ---

export const ConfigAction = z.discriminatedUnion('type', [
  SetJobNameAction,
  SetJobDescriptionAction,
  AddSeedUrlsAction,
  RemoveSeedUrlsAction,
  ReplaceSeedUrlsAction,
  SetCrawlDepthAction,
  SetMaxPagesAction,
  SetConcurrencyAction,
  SetCrawlerTypeAction,
  AddUserFieldAction,
  AddMultipleUserFieldsAction,
  RemoveUserFieldAction,
  ModifyUserFieldAction,
  ReorderUserFieldsAction,
  ReplaceAllUserFieldsAction,
  DefineNestedFieldAction,
  SetSchemaModeAction,
  SetEvolutionConfigAction,
  SetPrimaryModelAction,
  SetModelOverrideAction,
  ClearModelOverrideAction,
  SetMatchStrategyAction,
  SetConflictResolutionAction,
  SetSourcePriorityAction,
  SetActionApprovalPolicyAction,
  SaveAsTemplateAction,
  LoadTemplateAction,
  CloneJobConfigAction,
  ConfirmAndStartAction,
  ResetConfigAction,
]);

export type ConfigAction = z.infer<typeof ConfigAction>;
