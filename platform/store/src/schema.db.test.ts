import { METHODS, OUTCOMES } from '@spatula/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import type { Executor } from './client';
import {
  DECISION_OUTCOMES,
  FETCH_KINDS,
  ITEM_STATUSES,
  JUDGES,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  VERDICTS,
} from './schema';

/** The quoted values a CHECK constraint allows, as Postgres prints its definition. */
async function allowed(tx: Executor, constraint: string): Promise<string[]> {
  const rows = await tx.execute<{ def: string }>(
    sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${constraint}`,
  );
  const def = rows[0]?.def ?? '';
  return [...def.matchAll(/'([^']*)'/gu)].map((match) => match[1]!).sort();
}

describe('the CHECK lists', () => {
  it('allow exactly the values core and the store name, so neither can drift', () =>
    withRollback(async (tx) => {
      expect(await allowed(tx, 'fetches_outcome')).toEqual([...OUTCOMES].sort());
      expect(await allowed(tx, 'statements_method')).toEqual([...METHODS].sort());
      expect(await allowed(tx, 'items_status')).toEqual([...ITEM_STATUSES].sort());
    }));

  it('allow exactly the fetch kinds the store names', () =>
    withRollback(async (tx) => {
      expect(await allowed(tx, 'fetches_kind')).toEqual([...FETCH_KINDS].sort());
    }));

  it('allow exactly the decision, judgement, and review values the store names', () =>
    withRollback(async (tx) => {
      expect(await allowed(tx, 'decision_records_outcome')).toEqual([...DECISION_OUTCOMES].sort());
      expect(await allowed(tx, 'judgements_verdict')).toEqual([...VERDICTS].sort());
      expect(await allowed(tx, 'judgements_who')).toEqual([...JUDGES].sort());
      expect(await allowed(tx, 'review_items_kind')).toEqual([...REVIEW_KINDS].sort());
      expect(await allowed(tx, 'review_items_status')).toEqual([...REVIEW_STATUSES].sort());
    }));
});
