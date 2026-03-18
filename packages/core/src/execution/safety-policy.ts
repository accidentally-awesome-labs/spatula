import type { SafetyPolicy } from '../types/actions.js';

export type ApprovalPreset = 'trust_ai' | 'balanced' | 'cautious' | 'manual';

export const SAFETY_POLICY_MAP: Record<string, SafetyPolicy> = {
  // always_auto — low risk, produced inline by workers
  classify_page: 'always_auto',
  enqueue_links: 'always_auto',
  hint_entity_match: 'always_auto',
  update_enum_map: 'always_auto',
  flag_anomaly: 'always_auto',
  generate_documentation: 'always_auto',

  // auto_above_threshold — safe at high confidence
  add_field: 'auto_above_threshold',
  modify_field: 'auto_above_threshold',
  set_normalization_rule: 'auto_above_threshold',
  define_category: 'auto_above_threshold',
  assign_category_fields: 'auto_above_threshold',
  match_entities: 'auto_above_threshold',
  set_source_trust: 'auto_above_threshold',
  reprocess_extraction: 'auto_above_threshold',

  // batch_review — structural changes that benefit from human review
  merge_fields: 'batch_review',
  rename_field: 'batch_review',
  split_field: 'batch_review',
  group_fields: 'batch_review',
  resolve_conflict: 'batch_review',
  infer_value: 'batch_review',
  correct_value: 'batch_review',
  split_entities: 'batch_review',

  // always_review — destructive or high-impact
  remove_field: 'always_review',
  recommend_table_structure: 'always_review',
  derive_field: 'always_review',
};

export function resolvePolicy(actionType: string, preset: ApprovalPreset): SafetyPolicy {
  if (preset === 'trust_ai') return 'always_auto';
  if (preset === 'manual') return 'always_review';

  const basePolicy = SAFETY_POLICY_MAP[actionType];
  if (!basePolicy) return 'always_review';

  if (preset === 'cautious' && basePolicy === 'auto_above_threshold') {
    return 'batch_review';
  }

  return basePolicy;
}

export function shouldAutoApply(
  policy: SafetyPolicy,
  confidence: number,
  threshold: number,
): boolean {
  switch (policy) {
    case 'always_auto':
      return true;
    case 'auto_above_threshold':
      return confidence >= threshold;
    case 'batch_review':
    case 'always_review':
      return false;
  }
}
