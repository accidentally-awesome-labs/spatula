import { describe, it, expect } from 'vitest';
import {
  SAFETY_POLICY_MAP,
  resolvePolicy,
  shouldAutoApply,
  type ApprovalPreset,
} from '../../../src/execution/safety-policy.js';

describe('SAFETY_POLICY_MAP', () => {
  it('maps classify_page to always_auto', () => {
    expect(SAFETY_POLICY_MAP.classify_page).toBe('always_auto');
  });

  it('maps add_field to auto_above_threshold', () => {
    expect(SAFETY_POLICY_MAP.add_field).toBe('auto_above_threshold');
  });

  it('maps merge_fields to batch_review', () => {
    expect(SAFETY_POLICY_MAP.merge_fields).toBe('batch_review');
  });

  it('maps remove_field to always_review', () => {
    expect(SAFETY_POLICY_MAP.remove_field).toBe('always_review');
  });

  it('covers all 25 pipeline action types', () => {
    expect(Object.keys(SAFETY_POLICY_MAP)).toHaveLength(25);
  });
});

describe('resolvePolicy', () => {
  it('returns always_auto unchanged for balanced preset', () => {
    expect(resolvePolicy('classify_page', 'balanced')).toBe('always_auto');
  });

  it('returns always_auto for everything under trust_ai', () => {
    expect(resolvePolicy('remove_field', 'trust_ai')).toBe('always_auto');
    expect(resolvePolicy('merge_fields', 'trust_ai')).toBe('always_auto');
  });

  it('promotes auto_above_threshold to batch_review under cautious', () => {
    expect(resolvePolicy('add_field', 'cautious')).toBe('batch_review');
  });

  it('returns always_review for everything under manual', () => {
    expect(resolvePolicy('classify_page', 'manual')).toBe('always_review');
    expect(resolvePolicy('add_field', 'manual')).toBe('always_review');
  });

  it('returns always_review as fallback for unknown action type', () => {
    expect(resolvePolicy('unknown_type' as any, 'balanced')).toBe('always_review');
  });
});

describe('shouldAutoApply', () => {
  it('returns true for always_auto regardless of confidence', () => {
    expect(shouldAutoApply('always_auto', 0.1, 0.7)).toBe(true);
  });

  it('returns true for auto_above_threshold when confidence >= threshold', () => {
    expect(shouldAutoApply('auto_above_threshold', 0.8, 0.7)).toBe(true);
    expect(shouldAutoApply('auto_above_threshold', 0.7, 0.7)).toBe(true);
  });

  it('returns false for auto_above_threshold when confidence < threshold', () => {
    expect(shouldAutoApply('auto_above_threshold', 0.6, 0.7)).toBe(false);
  });

  it('returns false for batch_review', () => {
    expect(shouldAutoApply('batch_review', 1.0, 0.7)).toBe(false);
  });

  it('returns false for always_review', () => {
    expect(shouldAutoApply('always_review', 1.0, 0.7)).toBe(false);
  });
});
