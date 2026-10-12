import {
  INITIAL_GATE_STATE,
  type GateDecision,
  type GateState,
  type RobotsRecord,
} from '@spatula/core';
import { DurableObject } from 'cloudflare:workers';
import { GateKeeper } from './gate-port';

/**
 * One host's politeness, shared by every run that asks that host: one object per host name.
 * The state is a single stored value. The object's input gate holds other calls while it reads
 * and writes storage, so two runs can't both take the same slot.
 */
export class HostGate extends DurableObject<Env> {
  readonly #keeper = new GateKeeper({
    load: async () => (await this.ctx.storage.get<GateState>('state')) ?? INITIAL_GATE_STATE,
    save: (state) => this.ctx.storage.put('state', state),
  });

  robotsDue(now: number): Promise<boolean> {
    return this.#keeper.robotsDue(now);
  }

  storeRobots(record: RobotsRecord, now: number, minIntervalMs?: number): Promise<void> {
    return this.#keeper.storeRobots(record, now, minIntervalMs);
  }

  reserve(request: {
    url: string;
    now: number;
    minIntervalMs: number;
    maxWaitMs: number;
  }): Promise<GateDecision> {
    return this.#keeper.reserve(request);
  }

  record(response: { status: number; now: number; retryAfter: string | null }): Promise<void> {
    return this.#keeper.record(response);
  }
}
