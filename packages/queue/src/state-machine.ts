import type { JobStatus } from '@spatula/core';
import { StateError } from '@spatula/shared';

const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  pending: ['queued'],
  queued: ['running', 'cancelled'],
  running: ['paused', 'reconciling', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  reconciling: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const JobStateMachine = {
  transition(from: JobStatus, to: JobStatus): JobStatus {
    const allowed = TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new StateError(`Invalid job state transition: ${from} → ${to}`, { context: { from, to } });
    }
    return to;
  },

  canTransition(from: JobStatus, to: JobStatus): boolean {
    const allowed = TRANSITIONS[from];
    return !!allowed && allowed.includes(to);
  },

  getValidTransitions(from: JobStatus): JobStatus[] {
    return TRANSITIONS[from] ?? [];
  },
};
