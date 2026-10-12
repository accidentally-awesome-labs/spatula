import {
  gateInterval,
  INITIAL_GATE_STATE,
  recordResponse,
  reserve,
  robotsNeedsRefresh,
  robotsRecord,
  robotsToKeep,
  type GateDecision,
  type GateState,
  type RobotsRecord,
} from '@spatula/core';
import type { GatePort, HttpPort } from './refresh';
import { isChallenge } from './requests';

/*
 * Each host's politeness, kept apart from the pipeline. GateKeeper applies core's gate rules to a
 * host's stored state; the HostGate Durable Object keeps one per host, and tests keep them in
 * memory. createGatePort turns those gates into the pipeline's GatePort: before asking a host's
 * gate, it reads the host's robots.txt when the gate's copy is due, through the same HTTP port as
 * pages, so robots.txt gets the same honest user agent. That read is a request like a page's, so it
 * waits for the host's turn and for any break, and a challenge in answer to it isn't read as the
 * host having no rules.
 */

/** Where one host's gate state lives. */
export interface GateStore {
  load(): Promise<GateState>;
  save(state: GateState): Promise<void>;
}

/** RFC 9309 asks crawlers to read at least 500 KiB of a robots.txt file. */
const ROBOTS_MAX_BYTES = 512 * 1024;
/** RFC 9309 asks crawlers to follow at least five redirects. */
const ROBOTS_MAX_REDIRECTS = 5;

export class GateKeeper {
  constructor(private readonly store: GateStore) {}

  /** The stored state, with the defaults of anything added since it was saved. */
  private async state(): Promise<GateState> {
    return { ...INITIAL_GATE_STATE, ...(await this.store.load()) };
  }

  async robotsDue(now: number): Promise<boolean> {
    return robotsNeedsRefresh((await this.state()).robots, now);
  }

  /**
   * When the host next opens for a request: after its pacing and after any break, whichever is
   * later.
   */
  async opensAt(): Promise<number> {
    const state = await this.state();
    return Math.max(state.nextAt, state.backoffUntil);
  }

  /** Reading robots.txt is a request too, so the host's next one waits an interval after it. */
  async storeRobots(record: RobotsRecord, now: number, minIntervalMs = 0): Promise<void> {
    const state = await this.state();
    // A refresh that met a challenge leaves the rules held in force, and their Crawl-delay.
    const robots = robotsToKeep(state.robots, record);
    await this.store.save({
      ...state,
      robots,
      nextAt: Math.max(state.nextAt, now + gateInterval(robots, minIntervalMs)),
    });
  }

  async reserve(request: {
    url: string;
    now: number;
    minIntervalMs: number;
    maxWaitMs: number;
  }): Promise<GateDecision> {
    const { state, decision } = reserve(await this.state(), request);
    await this.store.save(state);
    return decision;
  }

  async record(response: {
    status: number;
    now: number;
    retryAfter: string | null;
  }): Promise<void> {
    await this.store.save(recordResponse(await this.state(), response));
  }
}

/** A host's gate, as the gate port uses it: a GateKeeper, or a HostGate stub. */
export type HostGateLike = Pick<
  GateKeeper,
  'robotsDue' | 'opensAt' | 'storeRobots' | 'reserve' | 'record'
>;

export function createGatePort(options: {
  gateFor(host: string): HostGateLike;
  http: HttpPort;
  now(): number;
}): GatePort {
  return {
    async reserve(url, request) {
      const target = new URL(url);
      const gate = options.gateFor(target.host);
      if (await gate.robotsDue(options.now())) {
        // Reading robots.txt is a request like a page's: it waits for the host's turn and for any
        // break, and the caller asks again when the host opens.
        const now = options.now();
        const opensAt = await gate.opensAt();
        if (opensAt > now) {
          return {
            kind: 'later',
            retryAfterMs: opensAt - now,
            reason: `${target.host} isn’t open for another request yet`,
          };
        }
        const record = await fetchRobots(options.http, target.origin, options.now);
        await gate.storeRobots(record, options.now(), request.minIntervalMs);
      }
      return gate.reserve({ url, now: options.now(), ...request });
    },
    async record(url, response) {
      await options.gateFor(new URL(url).host).record({ ...response, now: options.now() });
    },
  };
}

/** A host's robots.txt, as RFC 9309 reads the answer, following up to five HTTPS redirects. */
export async function fetchRobots(
  http: HttpPort,
  origin: string,
  now: () => number,
): Promise<RobotsRecord> {
  let url = `${origin}/robots.txt`;
  for (let hop = 0; hop <= ROBOTS_MAX_REDIRECTS; hop += 1) {
    const response = await http.get(url, {});
    if (!response.ok) return robotsRecord({ error: response.error }, now());
    if (isChallenge(response.headers)) return robotsRecord({ challenged: true }, now());
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      const next = URL.canParse(location, url) ? new URL(location, url) : null;
      if (next === null || next.protocol !== 'https:') {
        return robotsRecord(
          { error: `robots.txt redirected to ${location}, which isn’t an HTTPS address` },
          now(),
        );
      }
      url = next.href;
      continue;
    }
    const text = new TextDecoder().decode(response.body.subarray(0, ROBOTS_MAX_BYTES));
    return robotsRecord({ status: response.status, text }, now());
  }
  return robotsRecord(
    { error: `robots.txt redirected more than ${ROBOTS_MAX_REDIRECTS} times` },
    now(),
  );
}
