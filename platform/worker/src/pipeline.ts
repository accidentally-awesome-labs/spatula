import {
  EXTRACTION_VERSION,
  sourceIntervalMs,
  type Decider,
  type DecisionSummary,
  type Definition,
  type GateDecision,
  type LlmPort,
  type LlmUsage,
  type PackRegistry,
  type RunSummary,
  type TaxonomyDecider,
} from '@spatula/core';
import type { Executor, StatementCounts } from '@spatula/store';

/*
 * What every step of a refresh shares: the ports the Workflow or the tests pass in, the run's
 * context, where pages and snapshots are kept, the tags that say what code read a page, and the
 * run's LLM budget.
 */

/** The Workflow's steps, as the pipeline uses them. Step results are kept as JSON. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

/** Whether a request to a URL may go now, and what came of it. */
export interface GatePort {
  reserve(
    url: string,
    request: { minIntervalMs: number; maxWaitMs: number },
  ): Promise<GateDecision>;
  record(url: string, response: { status: number; retryAfter: string | null }): Promise<void>;
}

export type HttpResult =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
      truncated: boolean;
    }
  | { ok: false; error: string };

/**
 * One GET, never following redirects. Header names are lowercase; the body is read only for a 2xx,
 * up to `maxBytes` (5 MB unless the caller says otherwise).
 */
export interface HttpPort {
  get(
    url: string,
    headers: Record<string, string>,
    options?: { maxBytes?: number; accept?: string },
  ): Promise<HttpResult>;
}

export interface BlobPort {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Deletes these keys. A key that isn't there is no error. */
  delete(keys: readonly string[]): Promise<void>;
}

export interface RefreshPorts {
  withDb<T>(fn: (db: Executor) => Promise<T>): Promise<T>;
  gate: GatePort;
  http: HttpPort;
  blobs: BlobPort;
  llm: LlmPort | null;
  /** The decision cascade's decider, or null when no model is configured: then a person decides. */
  decider: Decider | null;
  /** The taxonomy's three-part decider (ADR 0007), or null when no model is configured. */
  taxonomyDecider: TaxonomyDecider | null;
  packs: PackRegistry;
  now(): Date;
  /** A wait inside a step, never longer than MAX_INLINE_WAIT_MS. */
  wait(ms: number): Promise<void>;
}

/** A source's standing as a run starts (ADR 0006). */
export interface Standing {
  /** Blocked runs in a row. */
  blockedRuns: number;
  /** Whether they refused it, so the run only probes it. */
  refused: boolean;
}

export interface Context {
  runId: string;
  datasetId: string;
  revision: number;
  definition: Definition;
  startedAt: Date;
  /** Each source's standing as the run started, by ID. A source without one is live. */
  standing?: Record<string, Standing>;
  /**
   * The taxonomy version the run places pages in (ADR 0007): null when the dataset's record type
   * has a taxonomy that isn't seeded yet, and absent for a record type without one.
   */
  taxonomyVersion?: number | null;
}

/**
 * How far apart this run asks a source's hosts: the definition's interval, doubled for each blocked
 * run in a row, up to four times (ADR 0006). robots.txt's Crawl-delay still applies when it asks for
 * longer: the gate takes the larger of the two.
 */
export function intervalFor(
  context: { definition: Definition; standing?: Record<string, Standing> },
  sourceId: string,
): number {
  return sourceIntervalMs(
    context.definition.policy.perHostIntervalMs,
    context.standing?.[sourceId]?.blockedRuns ?? 0,
  );
}

export const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };
export const NO_CHANGE: StatementCounts = { added: 0, reseen: 0, withdrawn: 0 };

/**
 * Where a page's body is kept: gzipped, under its SHA-256 as it arrived, so an unchanged page is
 * stored once (ADR 0008). A copy stored before the archive is under the bare hash
 * (`rawPageKey` in captures.ts).
 */
export const pageKey = (contentHash: string) => `pages/${contentHash}.gz`;
export const snapshotKey = (datasetId: string, snapshotId: string) =>
  `datasets/${datasetId}/snapshots/${snapshotId}.json`;
/** Where a held snapshot's records wait, before it has a generation. */
export const heldKey = (datasetId: string, snapshotId: string) =>
  `datasets/${datasetId}/held/${snapshotId}.json`;
/** Which definition revision and extraction code a page's statements came from. */
export const extractionTag = (revision: number) => `r${revision}.v${EXTRACTION_VERSION}`;
/** What a page is marked with when it has to be read again though nothing about it changed. */
export const retryTag = (revision: number) => `${extractionTag(revision)}.retry`;

/**
 * The tokens a run has spent on the LLM: reading pages, classifying and placing them, matching
 * them, and reviewing the taxonomy (ADR 0007).
 */
export function tokensSpent(summary: RunSummary): number {
  let spent = summary.llm.inputTokens + summary.llm.outputTokens;
  for (const counts of [summary.classify, summary.match, summary.taxonomy]) {
    spent += (counts?.inputTokens ?? 0) + (counts?.outputTokens ?? 0);
  }
  return spent;
}

/**
 * What's left of the run's LLM budget. It's read from the summary, which a run rebuilds from its
 * steps' results, so a run that replays its steps stops asking at the same page.
 */
export function budgetLeft(context: Context, summary: RunSummary): number {
  return context.definition.budget.llmTokensPerRun - tokensSpent(summary);
}

export function emptyDecisions(): DecisionSummary {
  return {
    rule: 0,
    accepted: 0,
    escalated: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** The summary's counts for one kind of decision, started at the run's first. */
export function decisionsOf(summary: RunSummary, kind: 'classify' | 'match'): DecisionSummary {
  const counts = summary[kind] ?? emptyDecisions();
  summary[kind] = counts;
  return counts;
}
