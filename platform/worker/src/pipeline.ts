import {
  EXTRACTION_VERSION,
  sourceIntervalMs,
  usdOf,
  type DownMarks,
  type Job,
  type ModelCall,
  type ModelPrice,
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
import type { ModelPortSet, ModelSetup } from './models';

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
  /**
   * The default model's (LLM_MODEL), or null when the deployment has no LLM: then a person decides,
   * and nothing is extracted by a model.
   */
  llm: LlmPort | null;
  /** The default model's decider for classify and match questions, or null when the deployment has no LLM: then a person decides. */
  decider: Decider | null;
  /** The default model's taxonomy decider, or null when the deployment has no LLM: then a person decides. */
  taxonomyDecider: TaxonomyDecider | null;
  /** The deployment's models: the default, what keeps a model from being asked, prices (ADR 0010). */
  models: ModelSetup;
  /**
   * A named model's ports (ADR 0010). Absent in the tests: every model answers through the three
   * ports above, which hold the fakes.
   */
  modelPorts?: (model: string) => ModelPortSet;
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

/** What a step needs to know of the run's LLM (ADR 0010): the dollars left, and the providers down. */
export interface LlmState {
  usdLeft: number;
  down: DownMarks;
}

/**
 * The run's spend so far, in dollars, rounded to a billionth, so that calls that add up to the
 * budget exactly spend it however their sum rounds.
 */
export function usdSpent(summary: RunSummary): number {
  let spent = 0;
  for (const byModel of Object.values(summary.spend ?? {})) {
    for (const spend of Object.values(byModel ?? {})) spent += spend.usd;
  }
  return Math.round(spent * 1e9) / 1e9;
}

/**
 * The run's LLM state, read from its summary, which a run rebuilds from its steps' results: a run
 * that replays its steps stops asking at the same page, and skips the same providers.
 */
export function llmState(context: Context, summary: RunSummary): LlmState {
  const left = Math.round((context.definition.budget.llmUsdPerRun - usdSpent(summary)) * 1e9) / 1e9;
  return {
    // Fail closed: every gate tests `usdLeft <= 0`, which a NaN from a corrupt summary would pass.
    usdLeft: Number.isFinite(left) ? left : 0,
    down: summary.llm.down ?? {},
  };
}

/**
 * Adds what a step asked of models to the run: each call, priced, under its job and model, and the
 * providers it found down, the first mark standing. A step result from before ADR 0010 has neither,
 * and adds nothing. A model with no price counts its calls and no dollars: `apply` refuses naming
 * one, so only a price removed since can do that.
 */
export function countCalls(
  summary: RunSummary,
  job: Job,
  step: { calls?: ModelCall[]; down?: DownMarks },
  price: (model: string) => ModelPrice | null,
): void {
  for (const call of step.calls ?? []) {
    const byJob = ((summary.spend ??= {})[job] ??= {});
    const spend = (byJob[call.model] ??= {
      calls: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
    });
    spend.calls += 1;
    if (call.failed) spend.failed += 1;
    spend.inputTokens += call.inputTokens;
    spend.outputTokens += call.outputTokens;
    const unit = price(call.model);
    if (unit !== null) spend.usd += usdOf(call, unit);
  }
  for (const [provider, down] of Object.entries(step.down ?? {})) {
    (summary.llm.down ??= {})[provider] ??= down;
  }
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
