import { z } from 'zod';
import { FieldDefinition, FieldRelevance } from './schema.js';
import { PageClassification, ExtractionStrategy } from './extraction.js';
import { TrustLevel } from './reconciliation.js';

export const ActionSource = z.enum([
  'extraction',
  'schema_evolution',
  'reconciliation',
  'quality_audit',
]);
export type ActionSource = z.infer<typeof ActionSource>;

export const ActionStatus = z.enum([
  'pending_review',
  'approved',
  'applied',
  'rejected',
  'rolled_back',
]);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const SafetyPolicy = z.enum([
  'always_auto',
  'auto_above_threshold',
  'always_review',
  'batch_review',
]);
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

const BaseAction = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  source: ActionSource,
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

// --- Schema Actions ---

const AddFieldAction = BaseAction.extend({
  type: z.literal('add_field'),
  payload: z.object({
    field: FieldDefinition,
    relevance: FieldRelevance,
    insertAfter: z.string().optional(),
  }),
});

const MergeFieldsAction = BaseAction.extend({
  type: z.literal('merge_fields'),
  payload: z.object({
    canonicalName: z.string(),
    aliasNames: z.array(z.string()),
    canonicalDefinition: FieldDefinition,
    valueMappings: z.record(z.unknown()),
  }),
});

const ModifyFieldAction = BaseAction.extend({
  type: z.literal('modify_field'),
  payload: z.object({
    fieldName: z.string(),
    changes: z.object({
      type: z
        .enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object'])
        .optional(),
      required: z.boolean().optional(),
      description: z.string().optional(),
      enumValues: z.array(z.string()).optional(),
    }),
  }),
});

const RemoveFieldAction = BaseAction.extend({
  type: z.literal('remove_field'),
  payload: z.object({
    fieldName: z.string(),
    reason: z.enum(['redundant', 'too_rare', 'merged_into_other', 'irrelevant']),
    mergedInto: z.string().optional(),
  }),
});

const RenameFieldAction = BaseAction.extend({
  type: z.literal('rename_field'),
  payload: z.object({
    currentName: z.string(),
    newName: z.string(),
    updateExistingData: z.boolean().default(true),
  }),
});

const SplitFieldAction = BaseAction.extend({
  type: z.literal('split_field'),
  payload: z.object({
    sourceField: z.string(),
    targetFields: z.array(FieldDefinition),
    splitLogic: z.string(),
    examples: z.array(
      z.object({
        sourceValue: z.unknown(),
        targetValues: z.record(z.unknown()),
      }),
    ),
  }),
});

const GroupFieldsAction = BaseAction.extend({
  type: z.literal('group_fields'),
  payload: z.object({
    targetFieldName: z.string(),
    targetFieldType: z.literal('object'),
    sourceFields: z.array(z.string()),
    mapping: z.record(z.string()),
  }),
});

// --- Normalization Actions ---

const SetNormalizationRuleAction = BaseAction.extend({
  type: z.literal('set_normalization_rule'),
  payload: z.object({
    fieldName: z.string(),
    rule: z.any(), // NormalizationRule — using any to avoid circular import complexity
    examples: z.array(
      z.object({
        before: z.unknown(),
        after: z.unknown(),
      }),
    ),
  }),
});

const UpdateEnumMapAction = BaseAction.extend({
  type: z.literal('update_enum_map'),
  payload: z.object({
    fieldName: z.string(),
    additions: z.record(z.string()),
    newCanonicalValues: z.array(z.string()).optional(),
  }),
});

// --- Category Actions ---

const DefineCategoryAction = BaseAction.extend({
  type: z.literal('define_category'),
  payload: z.object({
    categoryField: z.string(),
    categories: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        matchCriteria: z.string(),
      }),
    ),
  }),
});

const AssignCategoryFieldsAction = BaseAction.extend({
  type: z.literal('assign_category_fields'),
  payload: z.object({
    category: z.string(),
    requiredFields: z.array(z.string()),
    optionalFields: z.array(z.string()),
  }),
});

// --- Crawl Actions ---

const ClassifyPageAction = BaseAction.extend({
  type: z.literal('classify_page'),
  payload: z.object({
    pageId: z.string().uuid(),
    classification: PageClassification,
    estimatedEntryCount: z.number().optional(),
    extractionStrategy: ExtractionStrategy,
  }),
});

const EnqueueLinksAction = BaseAction.extend({
  type: z.literal('enqueue_links'),
  payload: z.object({
    links: z.array(
      z.object({
        url: z.string().url(),
        relevanceScore: z.number().min(0).max(1),
        expectedContent: z.enum(['single_entry', 'listing', 'pagination', 'category', 'unknown']),
        priority: z.enum(['high', 'medium', 'low']),
        anchorText: z.string().optional(),
      }),
    ),
  }),
});

const HintEntityMatchAction = BaseAction.extend({
  type: z.literal('hint_entity_match'),
  payload: z.object({
    currentExtractionId: z.string().uuid(),
    likelyMatchesPageUrl: z.string().url(),
    matchEvidence: z.string(),
  }),
});

// --- Reconciliation Actions ---

const MatchEntitiesAction = BaseAction.extend({
  type: z.literal('match_entities'),
  payload: z.object({
    entityId: z.string().uuid(),
    extractionIds: z.array(z.string().uuid()),
    matchedOn: z.array(z.string()),
  }),
});

const SplitEntitiesAction = BaseAction.extend({
  type: z.literal('split_entities'),
  payload: z.object({
    entityId: z.string().uuid(),
    newGroups: z.array(
      z.object({
        extractionIds: z.array(z.string().uuid()),
        reasoning: z.string(),
      }),
    ),
  }),
});

const ResolveConflictAction = BaseAction.extend({
  type: z.literal('resolve_conflict'),
  payload: z.object({
    entityId: z.string().uuid(),
    fieldName: z.string(),
    resolvedValue: z.unknown(),
    sourcePreferred: z.string(),
    allValues: z.array(
      z.object({
        source: z.string(),
        value: z.unknown(),
      }),
    ),
  }),
});

const InferValueAction = BaseAction.extend({
  type: z.literal('infer_value'),
  payload: z.object({
    entityId: z.string().uuid(),
    fieldName: z.string(),
    inferredValue: z.unknown(),
    inferredFrom: z.string(),
  }),
});

const CorrectValueAction = BaseAction.extend({
  type: z.literal('correct_value'),
  payload: z.object({
    entityId: z.string().uuid(),
    fieldName: z.string(),
    currentValue: z.unknown(),
    correctedValue: z.unknown(),
    correctionType: z.enum(['typo_fix', 'unit_correction', 'format_fix', 'logical_fix']),
  }),
});

const SetSourceTrustAction = BaseAction.extend({
  type: z.literal('set_source_trust'),
  payload: z.object({
    rankings: z.array(
      z.object({
        domain: z.string(),
        trustLevel: TrustLevel,
        reasoning: z.string(),
      }),
    ),
  }),
});

// --- Reprocessing Actions ---

const ReprocessExtractionAction = BaseAction.extend({
  type: z.literal('reprocess_extraction'),
  payload: z.object({
    extractionIds: z.array(z.string().uuid()),
    reason: z.enum(['schema_evolved', 'normalization_added', 'extraction_error']),
    targetSchemaVersion: z.number(),
  }),
});

// --- Finalization Actions ---

const RecommendTableStructureAction = BaseAction.extend({
  type: z.literal('recommend_table_structure'),
  payload: z.object({
    strategy: z.enum(['single_table', 'multi_table']),
    tables: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        fields: z.array(z.string()),
        relationship: z.enum(['primary', 'child']).optional(),
        foreignKey: z.string().optional(),
      }),
    ),
  }),
});

const DeriveFieldAction = BaseAction.extend({
  type: z.literal('derive_field'),
  payload: z.object({
    fieldName: z.string(),
    fieldDefinition: FieldDefinition,
    derivedFrom: z.array(z.string()),
    derivationLogic: z.string(),
    examples: z.array(
      z.object({
        inputs: z.record(z.unknown()),
        output: z.unknown(),
      }),
    ),
  }),
});

const FlagAnomalyAction = BaseAction.extend({
  type: z.literal('flag_anomaly'),
  payload: z.object({
    entityId: z.string().uuid().optional(),
    fieldName: z.string().optional(),
    anomalyType: z.enum([
      'outlier_value',
      'likely_typo',
      'contradictory_data',
      'suspicious_duplicate',
      'missing_critical',
    ]),
    description: z.string(),
    suggestedFix: z.unknown().optional(),
  }),
});

const GenerateDocumentationAction = BaseAction.extend({
  type: z.literal('generate_documentation'),
  payload: z.object({
    dataDictionary: z.array(
      z.object({
        fieldName: z.string(),
        description: z.string(),
        valueRange: z.string().optional(),
        exampleValues: z.array(z.unknown()),
        coveragePercent: z.number(),
        sources: z.array(z.string()),
      }),
    ),
    categoryBreakdown: z.array(
      z.object({
        category: z.string(),
        count: z.number(),
        specificFields: z.array(z.string()),
      }),
    ),
    qualitySummary: z.object({
      totalEntities: z.number(),
      totalSources: z.number(),
      averageFieldCompleteness: z.number(),
      anomaliesFound: z.number(),
      anomaliesResolved: z.number(),
    }),
  }),
});

// --- Union ---

export const PipelineAction = z.discriminatedUnion('type', [
  AddFieldAction,
  MergeFieldsAction,
  ModifyFieldAction,
  RemoveFieldAction,
  RenameFieldAction,
  SplitFieldAction,
  GroupFieldsAction,
  SetNormalizationRuleAction,
  UpdateEnumMapAction,
  DefineCategoryAction,
  AssignCategoryFieldsAction,
  ClassifyPageAction,
  EnqueueLinksAction,
  HintEntityMatchAction,
  MatchEntitiesAction,
  SplitEntitiesAction,
  ResolveConflictAction,
  InferValueAction,
  CorrectValueAction,
  SetSourceTrustAction,
  ReprocessExtractionAction,
  RecommendTableStructureAction,
  DeriveFieldAction,
  FlagAnomalyAction,
  GenerateDocumentationAction,
]);

export type PipelineAction = z.infer<typeof PipelineAction>;
