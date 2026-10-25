import type { ComparisonReport, RunSummary } from '@spatula/core';
import { StaleDefinitionError } from '@spatula/store';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { runComparison, type CompareParams } from './compare';
import { workerPorts } from './ports';
import { SnapshotFileMissingError } from './publish';
import { DatasetMissingError, runRefresh, type RefreshParams, type StepRunner } from './refresh';

/** The Refresh Workflow: the pipeline over real ports. Its instance ID is the run's ID. */
export class RefreshWorkflow extends WorkflowEntrypoint<Env, RefreshParams> {
  async run(
    event: Readonly<WorkflowEvent<RefreshParams>>,
    step: WorkflowStep,
  ): Promise<RunSummary> {
    return runRefresh(event.payload, stepRunner(step), workerPorts(this.env));
  }
}

/**
 * The Compare Workflow (ADR 0010): a model comparison over the same ports as a run. Its instance ID
 * is the comparison's ID, and its output is the report it also puts in R2.
 */
export class CompareWorkflow extends WorkflowEntrypoint<Env, CompareParams> {
  async run(
    event: Readonly<WorkflowEvent<CompareParams>>,
    step: WorkflowStep,
  ): Promise<ComparisonReport> {
    return runComparison(event.payload, stepRunner(step), workerPorts(this.env));
  }
}

/**
 * Workflows' steps as the pipeline's StepRunner. A dataset that doesn't exist, whose stored
 * definition no longer passes the checks, or whose last snapshot's file is gone, isn't retried: a
 * retry would find the same thing.
 */
export function stepRunner(step: WorkflowStep): StepRunner {
  // Workflows types step results as serializable values. The pipeline's are plain JSON, which the
  // Node tests' fake step checks, so its generic signature is enough here. The step is an RPC stub
  // of the Workflows engine, so its methods are only ever called on it: a bound or detached one
  // would be a call to a remote method named "bind".
  const plain = step as unknown as {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  };
  return {
    do: (name, fn) =>
      plain.do(name, async () => {
        try {
          return await fn();
        } catch (error) {
          if (
            error instanceof DatasetMissingError ||
            error instanceof StaleDefinitionError ||
            error instanceof SnapshotFileMissingError
          ) {
            throw new NonRetryableError(error.message);
          }
          throw error;
        }
      }),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}
