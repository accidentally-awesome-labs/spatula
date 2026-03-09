import type { JobStatus } from '@spatula/core';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`Invalid job state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const TRANSITIONS: Record<string, JobStatus[]> = {
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
      throw new InvalidTransitionError(from, to);
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
