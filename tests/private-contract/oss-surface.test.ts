import { describe, it, expect } from 'vitest';

// =============================================================================
// Reverse private-contract: spatula-saas mock-consumer surface assertions
// =============================================================================
//
// This file mirrors the shape of a realistic spatula-saas import block. It does
// NOT enumerate every export; it pins the specific symbols the private repo
// consumes today. Renaming or removing any pinned symbol breaks this test, the
// PR fails CI, and the saas owner is forced to open a mirror PR before merge.
//
// SCOPE: TypeScript surface only. SQL schema, RLS policies, FK behavior, and
// runtime semantic drift are NOT covered here — those live in:
//   - tests/private-contract/schema-lint.test.ts (SQL schema lint)
//   - docs/private-contract.md (runtime / RLS residual-risk register, Plan 15-06)
//
// All imports are top-level so any missing-symbol failure surfaces at module-
// evaluation time (= clear stack trace at import line, not deep in a runtime
// test body).

import * as core from '@spatula/core';
import * as dbBarrel from '@spatula/db';
import * as queue from '@spatula/queue';
import * as shared from '@spatula/shared';
import * as api from '../../apps/api/src/app.js';

// Per CONTEXT.md "Specifics" — destructure under realistic names that mimic
// what saas-side code would actually do.
const {
  processCrawlTask,
  processSchemaEvolution,
  processReconciliation,
  processExport,
} = core;

const {
  createDatabase,
  createDatabasePool,
  TenantRepository,
  JobRepository,
  ApiKeyRepository,
  DlqRepository,
  UserTenantRepository,
  AuditLogRepository,
  tenants,
  jobs,
  apiKeys,
} = dbBarrel;

const { createQueues, QUEUE_NAMES, DEFAULT_QUEUE_CONFIG, JobManager } = queue;

const { createLogger, loadConfig, DEFAULT_RATE_LIMIT } = shared;

const { createApp } = api;

// =============================================================================
// Describe blocks — one per consumed package
// =============================================================================

describe('@spatula/core pipeline processors (consumed by spatula-saas billing wrappers)', () => {
  it('exports processCrawlTask as a function', () => {
    expect(typeof processCrawlTask).toBe('function');
  });
  it('exports processSchemaEvolution as a function', () => {
    expect(typeof processSchemaEvolution).toBe('function');
  });
  it('exports processReconciliation as a function', () => {
    expect(typeof processReconciliation).toBe('function');
  });
  it('exports processExport as a function', () => {
    expect(typeof processExport).toBe('function');
  });
});

describe('@spatula/db repositories + connection + Drizzle schemas', () => {
  it('exports the connection factories', () => {
    expect(typeof createDatabase).toBe('function');
    expect(typeof createDatabasePool).toBe('function');
  });
  it('exports the 6 repositories saas wraps for metering / quota / audit', () => {
    expect(typeof TenantRepository).toBe('function'); // class constructor
    expect(typeof JobRepository).toBe('function');
    expect(typeof ApiKeyRepository).toBe('function');
    expect(typeof DlqRepository).toBe('function');
    expect(typeof UserTenantRepository).toBe('function');
    expect(typeof AuditLogRepository).toBe('function');
  });
  it('exports the 3 Drizzle schema tables saas joins against', () => {
    // Drizzle schema objects are functions-as-objects with a `.name` runtime
    // property; the only safe cross-version check is they're defined.
    expect(tenants).toBeDefined();
    expect(jobs).toBeDefined();
    expect(apiKeys).toBeDefined();
  });
});

describe('@spatula/queue primitives (consumed for billing-event enqueueing)', () => {
  it('exports createQueues factory', () => {
    expect(typeof createQueues).toBe('function');
  });
  it('exports QUEUE_NAMES constant', () => {
    expect(QUEUE_NAMES).toBeDefined();
  });
  it('exports DEFAULT_QUEUE_CONFIG constant', () => {
    expect(DEFAULT_QUEUE_CONFIG).toBeDefined();
  });
  it('exports JobManager class', () => {
    expect(typeof JobManager).toBe('function');
  });
});

describe('@spatula/shared primitives (with affirmative billing-absent assertions)', () => {
  it('exports createLogger as a function', () => {
    expect(typeof createLogger).toBe('function');
  });
  it('exports loadConfig as a function', () => {
    expect(typeof loadConfig).toBe('function');
  });
  it('exports DEFAULT_RATE_LIMIT as an object', () => {
    expect(DEFAULT_RATE_LIMIT).toBeDefined();
    expect(typeof DEFAULT_RATE_LIMIT).toBe('object');
  });
  it('does NOT export BILLING_TIERS (carved out — saas owns billing tiers)', () => {
    expect((shared as Record<string, unknown>).BILLING_TIERS).toBeUndefined();
  });
  it('does NOT export RATE_LIMIT_TIERS (collapsed to DEFAULT_RATE_LIMIT)', () => {
    expect((shared as Record<string, unknown>).RATE_LIMIT_TIERS).toBeUndefined();
  });
});

describe('@spatula/api createApp factory (consumed via direct path import)', () => {
  it('exports createApp as a function', () => {
    expect(typeof createApp).toBe('function');
  });
});

describe('does not export any billing/stripe symbol from any package', () => {
  // Filter pattern: catch every billing-coupled name the carve-out removed.
  // If saas accidentally re-introduces one into the OSS barrel, this test
  // turns red on the next PR.
  const FORBIDDEN = /stripe|billing|quotaEnforcer|usageRecord|metering/i;

  function findForbidden(label: string, mod: Record<string, unknown>): string[] {
    return Object.keys(mod).filter((k) => FORBIDDEN.test(k)).map((k) => `${label}.${k}`);
  }

  it('@spatula/core has no billing/stripe exports', () => {
    expect(findForbidden('core', core as Record<string, unknown>)).toEqual([]);
  });
  it('@spatula/db has no billing/stripe exports', () => {
    expect(findForbidden('db', dbBarrel as Record<string, unknown>)).toEqual([]);
  });
  it('@spatula/queue has no billing/stripe exports', () => {
    expect(findForbidden('queue', queue as Record<string, unknown>)).toEqual([]);
  });
  it('@spatula/shared has no billing/stripe exports', () => {
    expect(findForbidden('shared', shared as Record<string, unknown>)).toEqual([]);
  });
});
