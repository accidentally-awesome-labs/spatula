import { createLogger } from '@spatula/shared';
import type { ConflictResolution } from '../types/job.js';
import type { SourceTrust } from '../types/reconciliation.js';

const logger = createLogger('conflict-resolver');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldConflictValue {
  source: string;
  value: unknown;
  extractionId: string;
  crawledAt: Date;
}

export interface FieldConflict {
  fieldName: string;
  values: FieldConflictValue[];
}

export interface ResolvedField {
  fieldName: string;
  resolvedValue: unknown;
  sourcePreferred: string;
  hadConflict: boolean;
  resolution: ConflictResolution;
}

export interface ConflictResolverOptions {
  trustRankings?: SourceTrust[];
}

// ---------------------------------------------------------------------------
// Trust level ordering (higher index = more trusted)
// ---------------------------------------------------------------------------

const TRUST_LEVEL_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  authoritative: 3,
};

// ---------------------------------------------------------------------------
// Strategy: most_common
// ---------------------------------------------------------------------------

function resolveMostCommon(values: FieldConflictValue[]): FieldConflictValue {
  const counts = new Map<string, { count: number; first: FieldConflictValue }>();

  for (const v of values) {
    const key = JSON.stringify(v.value);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { count: 1, first: v });
    }
  }

  let best: { count: number; first: FieldConflictValue } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }

  return best!.first;
}

// ---------------------------------------------------------------------------
// Strategy: most_recent
// ---------------------------------------------------------------------------

function resolveMostRecent(values: FieldConflictValue[]): FieldConflictValue {
  let latest = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i].crawledAt.getTime() > latest.crawledAt.getTime()) {
      latest = values[i];
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Strategy: source_priority
// ---------------------------------------------------------------------------

function resolveSourcePriority(
  values: FieldConflictValue[],
  trustRankings?: SourceTrust[],
): FieldConflictValue {
  if (!trustRankings || trustRankings.length === 0) {
    return resolveMostCommon(values);
  }

  const trustMap = new Map(trustRankings.map((r) => [r.domain, r.trustLevel]));

  let best = values[0];
  let bestScore = TRUST_LEVEL_ORDER[trustMap.get(best.source) ?? 'medium'] ?? 1;

  for (let i = 1; i < values.length; i++) {
    const score = TRUST_LEVEL_ORDER[trustMap.get(values[i].source) ?? 'medium'] ?? 1;
    if (score > bestScore) {
      best = values[i];
      bestScore = score;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Strategy: most_complete
// ---------------------------------------------------------------------------

function stringifiedLength(value: unknown): number {
  const s = JSON.stringify(value);
  return s === undefined ? 0 : s.length;
}

function resolveMostComplete(values: FieldConflictValue[]): FieldConflictValue {
  let best = values[0];
  let bestLen = stringifiedLength(best.value);

  for (let i = 1; i < values.length; i++) {
    const len = stringifiedLength(values[i].value);
    if (len > bestLen) {
      best = values[i];
      bestLen = len;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

function allSameValue(values: FieldConflictValue[]): boolean {
  if (values.length <= 1) return true;
  const first = JSON.stringify(values[0].value);
  for (let i = 1; i < values.length; i++) {
    if (JSON.stringify(values[i].value) !== first) return false;
  }
  return true;
}

export function resolveConflict(
  conflict: FieldConflict,
  strategy: ConflictResolution,
  options?: ConflictResolverOptions,
): ResolvedField {
  const { fieldName, values } = conflict;

  // Single value — no actual conflict
  if (values.length === 1) {
    return {
      fieldName,
      resolvedValue: values[0].value,
      sourcePreferred: values[0].source,
      hadConflict: false,
      resolution: strategy,
    };
  }

  // All same value — no actual conflict
  if (allSameValue(values)) {
    return {
      fieldName,
      resolvedValue: values[0].value,
      sourcePreferred: values[0].source,
      hadConflict: false,
      resolution: strategy,
    };
  }

  // True conflict — pick based on strategy
  let winner: FieldConflictValue;

  switch (strategy) {
    case 'most_common':
      winner = resolveMostCommon(values);
      break;
    case 'most_recent':
      winner = resolveMostRecent(values);
      break;
    case 'source_priority':
      winner = resolveSourcePriority(values, options?.trustRankings);
      break;
    case 'most_complete':
      winner = resolveMostComplete(values);
      break;
    case 'llm_resolved':
      logger.debug('llm_resolved strategy requested; falling back to most_common');
      winner = resolveMostCommon(values);
      break;
    default:
      winner = resolveMostCommon(values);
      break;
  }

  return {
    fieldName,
    resolvedValue: winner.value,
    sourcePreferred: winner.source,
    hadConflict: true,
    resolution: strategy,
  };
}
