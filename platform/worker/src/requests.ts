import type { ContentSignals } from '@spatula/core';
import type { GatePort, HttpPort } from './refresh';

/*
 * One request through its host's gate. Every hop, redirects included, asks the host's gate first,
 * and every answer goes back to it, so pacing, robots.txt, and back-off apply to each. Only HTTPS
 * addresses are followed. Pages and sitemaps both come through here.
 */

/** Waits up to this long happen inside a step; longer ones become Workflow sleeps. */
export const MAX_INLINE_WAIT_MS = 15_000;
/** How many times one request may be put off before it's recorded as failed. */
export const MAX_WAITS = 5;
export const MAX_REDIRECTS = 5;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type Requested =
  | { kind: 'later'; retryAfterMs: number }
  | {
      kind: 'denied';
      outcome: 'blocked' | 'failed';
      reason: string;
      url: string;
      signals: ContentSignals;
    }
  | {
      kind: 'failed';
      error: string;
      httpStatus: number | null;
      url: string;
      signals: ContentSignals;
    }
  | {
      kind: 'answered';
      url: string;
      signals: ContentSignals;
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
      truncated: boolean;
    };

export async function requestThroughGate(
  ports: { gate: GatePort; http: HttpPort; wait(ms: number): Promise<void> },
  address: string,
  options: {
    minIntervalMs: number;
    /** Whether a wait too long for a step fails the request instead of putting it off. */
    giveUp: boolean;
    /** Headers for the first hop only, such as conditional ones. */
    headers: Record<string, string>;
    maxBytes?: number;
    accept?: string;
  },
): Promise<Requested> {
  let url = address;
  let signals: ContentSignals = {};
  const failed = (error: string, httpStatus: number | null = null): Requested => ({
    kind: 'failed',
    error,
    httpStatus,
    url,
    signals,
  });

  for (let hop = 0; ; hop += 1) {
    const decision = await ports.gate.reserve(url, {
      minIntervalMs: options.minIntervalMs,
      maxWaitMs: MAX_INLINE_WAIT_MS,
    });
    if (decision.kind === 'later') {
      if (!options.giveUp) return { kind: 'later', retryAfterMs: decision.retryAfterMs };
      return failed(`${decision.reason}, and the run stopped waiting after ${MAX_WAITS} tries`);
    }
    if (decision.kind === 'deny') {
      return { kind: 'denied', outcome: decision.outcome, reason: decision.reason, url, signals };
    }
    signals = decision.signals;
    if (decision.waitMs > 0) await ports.wait(decision.waitMs);

    const response = await ports.http.get(url, hop === 0 ? options.headers : {}, {
      maxBytes: options.maxBytes,
      accept: options.accept,
    });
    await ports.gate.record(
      url,
      response.ok
        ? { status: response.status, retryAfter: response.headers['retry-after'] ?? null }
        : { status: 0, retryAfter: null },
    );
    if (!response.ok) return failed(response.error);

    const location = response.headers.location;
    if (REDIRECTS.has(response.status) && location !== undefined) {
      const next = URL.canParse(location, url) ? new URL(location, url) : null;
      if (next === null) {
        return failed(`redirected to ${location}, which isn’t an address`, response.status);
      }
      if (next.protocol !== 'https:') {
        return failed(`redirected to ${next.href}, which isn’t HTTPS`, response.status);
      }
      if (hop === MAX_REDIRECTS) {
        return failed(`redirected more than ${MAX_REDIRECTS} times`, response.status);
      }
      url = next.href;
      continue;
    }
    return {
      kind: 'answered',
      url,
      signals,
      status: response.status,
      headers: response.headers,
      body: response.body,
      truncated: response.truncated,
    };
  }
}
