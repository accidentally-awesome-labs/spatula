import {
  newId,
  specLabelKey,
  type FieldValue,
  type Method,
  type StatementInput,
} from '@spatula/core';
import type { Executor } from '../src/client';
import { applyDefinition, listLiveItems, type ItemRef } from '../src/datasets';
import type { NewDecision } from '../src/decisions';
import { recordFetch } from '../src/fetches';
import { testDefinition } from '../src/fixtures';
import { startRun } from '../src/runs';

/** 2026-10-10 at 00:mm UTC. */
export const T = (minute: number) => new Date(Date.UTC(2026, 9, 10, 0, minute));

/** The test dataset, its live items (a1, a2, b1), and a running run. */
export async function seedDataset(db: Executor): Promise<{ items: ItemRef[]; runId: string }> {
  await applyDefinition(db, testDefinition());
  const runId = 'test-products-202610100000';
  await startRun(db, { id: runId, datasetId: 'test-products' });
  return { items: await listLiveItems(db, 'test-products'), runId };
}

/** Records a successful fetch of the item at the given time, and returns its ID. */
export async function fetchOf(
  db: Executor,
  runId: string,
  item: ItemRef,
  at: Date,
): Promise<string> {
  const id = newId('fe');
  await recordFetch(db, {
    id,
    runId,
    itemId: item.id,
    url: item.locator,
    finalUrl: item.locator,
    policy: 'allowed',
    policyReason: null,
    method: 'http',
    outcome: 'changed',
    httpStatus: 200,
    bytes: 1000,
    signals: {},
    startedAt: at,
    durationMs: 120,
    error: null,
    page: { contentHash: `hash-${at.getTime()}`, etag: null, lastModified: null },
  });
  return id;
}

/**
 * A statement as an extraction would propose it. Specs key on their label and value, the way
 * core's `normalizeValue` keys them.
 */
export function statementOf(
  property: string,
  value: FieldValue,
  method: Method = 'rule',
): StatementInput {
  return {
    property,
    value,
    valueKey:
      typeof value === 'string' ? value : `${specLabelKey(value.label)}\u001f${value.value}`,
    original: typeof value === 'string' ? value : JSON.stringify(value),
    method,
    path: method === 'llm' ? 'llm:specs[0]' : `test:${property}`,
    confidence: method === 'rule' ? 1 : method === 'llm' ? 0.6 : 0.9,
    position: property === 'gtins' || property === 'mpns' || property === 'specs' ? 0 : null,
  };
}

/** The answer that made a page irrelevant: it is none of the dataset's categories. */
export const noneOfThese = (datasetId: string, itemId: string): NewDecision => ({
  id: `dc_none_${itemId}`,
  datasetId,
  type: 'classify',
  subject: itemId,
  subjectKey: `classify:${itemId}`,
  state: {},
  stateHash: 'hash',
  question: { type: 'choice', prompt: 'Which?', options: ['Headphones', 'None of these'] },
  criteriaVersion: 1,
  adapter: 'llm:test-model',
  probabilities: { 'None of these': 0.95 },
  evidence: 'Ear pads.',
  thresholds: { accept: 0.9 },
  outcome: 'accepted',
  answer: 'None of these',
  inputTokens: 0,
  outputTokens: 0,
  decidedAt: new Date(),
});
