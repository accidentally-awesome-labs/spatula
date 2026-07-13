// packages/queue/src/derive-job-deps.ts
// Derives per-job WorkerDeps from a job's LLMConfig, reusing the shared llmClient
// and all non-LLM singletons (crawler, repos, contentStore, queues).
//
// Only the 5 LLM-config-dependent components are rebuilt per job so that each job's
// llm.primaryModel + modelOverrides are honored without creating new DB connections
// or crawlers on every task.

import type { LLMClient, LLMConfig } from '@spatula/core';
import {
  PageClassifier,
  StaticExtractor,
  SchemaEvolverImpl,
  DataReconcilerImpl,
  LLMLinkEvaluator,
  resolveModel,
} from '@spatula/core';
import { WorkerDeps } from './worker-deps.js';

/**
 * Rebuild the 5 LLM-config-dependent components from a job's LLMConfig over the
 * shared llmClient. All shared singletons (crawler, repos, contentStore, queues)
 * are passed through unchanged — only the per-job components differ.
 *
 * Race-safe by construction: each job call creates its own instances over the
 * one shared llmClient (which carries the CircuitBreaker + usage recorder).
 */
export function deriveJobDeps(
  base: WorkerDeps,
  llmClient: LLMClient,
  jobLlmConfig: LLMConfig,
  jobId: string,
): WorkerDeps {
  return new WorkerDeps({
    // ── Shared singletons ────────────────────────────────────────────────────
    // These are never rebuilt per job — they hold DB connections, open browser
    // processes, and Redis connections. Pass them through unchanged.
    dbPool: base.dbPool,
    crawler: base.crawler,
    contentStore: base.contentStore,
    jobRepo: base.jobRepo,
    taskRepo: base.taskRepo,
    pageRepo: base.pageRepo,
    extractionRepo: base.extractionRepo,
    schemaRepo: base.schemaRepo,
    entityRepo: base.entityRepo,
    sourceTrustRepo: base.sourceTrustRepo,
    entitySourceRepo: base.entitySourceRepo,
    exportRepo: base.exportRepo,
    actionRepo: base.actionRepo,
    queues: base.queues,
    eventPublisher: base.eventPublisher,
    robotsChecker: base.robotsChecker,
    rateLimiter: base.rateLimiter,
    pageBudget: base.pageBudget,
    completionChecker: base.completionChecker,
    tenantRepo: base.tenantRepo,
    // ── Per-job: rebuilt from jobLlmConfig over the shared llmClient ─────────
    // These 5 components resolve the LLM model from construction-time config
    // (proven in static-extractor.ts:76,105 — resolveModel(this.config,'extraction')).
    // Rebuilding them per job is the only way to honor per-job model tiers.
    classifier: new PageClassifier(llmClient, jobLlmConfig),
    extractor: new StaticExtractor(llmClient, jobLlmConfig, jobId),
    schemaEvolver: new SchemaEvolverImpl(llmClient, jobLlmConfig),
    reconciler: new DataReconcilerImpl(llmClient, jobLlmConfig),
    linkEvaluator: new LLMLinkEvaluator(llmClient, resolveModel(jobLlmConfig, 'linkEvaluation')),
  });
}

/**
 * Async helper used by each handler (crawl/schema/reconciliation) to derive per-job
 * deps from the job's stored LLMConfig.
 *
 * Fallback behavior (for test paths / no LLM client):
 *   - If sharedClient is undefined → return base deps unchanged (no crash, existing
 *     unit tests continue to work — they pass no llmClient).
 *   - If job not found or job.config.llm is absent → fall back to the default
 *     config embedded on deps by buildWorkerDeps.
 */
export async function resolveJobDeps(
  deps: WorkerDeps,
  sharedClient: LLMClient | undefined,
  jobId: string,
  tenantId: string,
): Promise<WorkerDeps> {
  // No shared client → test-injection path or pre-built deps; return as-is.
  if (!sharedClient) {
    return deps;
  }

  // Load the job to read its per-job LLM config.
  const job = await deps.jobRepo.findById(jobId, tenantId);
  const jobLlmConfig: LLMConfig = (job?.config as any)?.llm ??
    (deps as any).defaultLlmConfig ?? { primaryModel: 'deepseek/deepseek-v4-flash' };

  return deriveJobDeps(deps, sharedClient, jobLlmConfig, jobId);
}
