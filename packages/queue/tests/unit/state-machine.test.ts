import { describe, it, expect } from 'vitest';
import { JobStateMachine, InvalidTransitionError } from '../../src/state-machine.js';

describe('JobStateMachine', () => {
  it('allows pending → queued', () => {
    expect(JobStateMachine.transition('pending', 'queued')).toBe('queued');
  });

  it('allows queued → running', () => {
    expect(JobStateMachine.transition('queued', 'running')).toBe('running');
  });

  it('allows running → paused', () => {
    expect(JobStateMachine.transition('running', 'paused')).toBe('paused');
  });

  it('allows paused → running (resume)', () => {
    expect(JobStateMachine.transition('paused', 'running')).toBe('running');
  });

  it('allows running → reconciling', () => {
    expect(JobStateMachine.transition('running', 'reconciling')).toBe('reconciling');
  });

  it('allows reconciling → completed', () => {
    expect(JobStateMachine.transition('reconciling', 'completed')).toBe('completed');
  });

  it('allows running → failed', () => {
    expect(JobStateMachine.transition('running', 'failed')).toBe('failed');
  });

  it('allows running → cancelled', () => {
    expect(JobStateMachine.transition('running', 'cancelled')).toBe('cancelled');
  });

  it('allows paused → cancelled', () => {
    expect(JobStateMachine.transition('paused', 'cancelled')).toBe('cancelled');
  });

  it('rejects invalid transitions', () => {
    expect(() => JobStateMachine.transition('pending', 'completed')).toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects transitions from terminal states', () => {
    expect(() => JobStateMachine.transition('completed', 'running')).toThrow(
      InvalidTransitionError,
    );
    expect(() => JobStateMachine.transition('failed', 'running')).toThrow(InvalidTransitionError);
    expect(() => JobStateMachine.transition('cancelled', 'running')).toThrow(
      InvalidTransitionError,
    );
  });

  it('canTransition returns boolean', () => {
    expect(JobStateMachine.canTransition('pending', 'queued')).toBe(true);
    expect(JobStateMachine.canTransition('pending', 'completed')).toBe(false);
  });

  it('getValidTransitions returns allowed next states', () => {
    const from_running = JobStateMachine.getValidTransitions('running');
    expect(from_running).toContain('paused');
    expect(from_running).toContain('reconciling');
    expect(from_running).toContain('failed');
    expect(from_running).toContain('cancelled');
    expect(from_running).not.toContain('pending');
  });
});
