/**
 * Frozen v1 action-type enum.
 *
 * Lists every action `type` discriminator emitted by `PipelineAction` (25
 * pipeline actions) and the config-action surface. Frozen at v1; additive-only
 * in 1.x.
 *
 * Source-of-truth: the `PipelineAction` discriminated union in
 * `packages/core-types/src/schemas/action.ts` (pipeline) and the config-action
 * registry in `@accidentally-awesome-labs/spatula-core` (config). This enum is the lightweight
 * value-import for callers that need the string list without pulling in zod.
 */
export const ActionType = {
  // --- Schema Actions ---
  ADD_FIELD: 'add_field',
  MERGE_FIELDS: 'merge_fields',
  MODIFY_FIELD: 'modify_field',
  REMOVE_FIELD: 'remove_field',
  RENAME_FIELD: 'rename_field',
  SPLIT_FIELD: 'split_field',
  GROUP_FIELDS: 'group_fields',

  // --- Normalization Actions ---
  SET_NORMALIZATION_RULE: 'set_normalization_rule',
  UPDATE_ENUM_MAP: 'update_enum_map',

  // --- Category Actions ---
  DEFINE_CATEGORY: 'define_category',
  ASSIGN_CATEGORY_FIELDS: 'assign_category_fields',

  // --- Crawl Actions ---
  CLASSIFY_PAGE: 'classify_page',
  ENQUEUE_LINKS: 'enqueue_links',
  HINT_ENTITY_MATCH: 'hint_entity_match',

  // --- Reconciliation Actions ---
  MATCH_ENTITIES: 'match_entities',
  SPLIT_ENTITIES: 'split_entities',
  RESOLVE_CONFLICT: 'resolve_conflict',
  INFER_VALUE: 'infer_value',
  CORRECT_VALUE: 'correct_value',
  SET_SOURCE_TRUST: 'set_source_trust',

  // --- Reprocessing Actions ---
  REPROCESS_EXTRACTION: 'reprocess_extraction',

  // --- Finalization Actions ---
  RECOMMEND_TABLE_STRUCTURE: 'recommend_table_structure',
  DERIVE_FIELD: 'derive_field',
  FLAG_ANOMALY: 'flag_anomaly',
  GENERATE_DOCUMENTATION: 'generate_documentation',
} as const;

export type ActionType = (typeof ActionType)[keyof typeof ActionType];
