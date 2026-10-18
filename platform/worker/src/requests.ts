import type { ContentSignals } from '@spatula/core';
import type { GatePort, HttpPort } from './pipeline';

/*
 * One request through its host's gate. Every hop, redirects included, asks the host's gate first,
 * and every answer goes back to it, so pacing, robots.txt, and back-off apply to each. Only HTTPS
 * addresses are followed. Pages and sitemaps both come through here.
 *
 * A hop the gate puts off is asked for again where it left off. Starting over would ask the first
 * hop again for an answer it already gave, and when the pacing interval is longer than a step
 * waits, every hop after the first is put off, so the request would never get past a redirect.
 */

/** Waits up to this long happen inside a step; longer ones become Workflow sleeps. */
export const MAX_INLINE_WAIT_MS = 15_000;
/** How many times one request may be put off before it's recorded as failed. */
export const MAX_WAITS = 5;
export const MAX_REDIRECTS = 5;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Whether the site served a challenge in place of what was asked for, as Cloudflare marks it, with
 * whatever status. Pages, sitemaps, and robots.txt all read an answer this way.
 */
export function isChallenge(headers: Record<string, string>): boolean {
  return headers['cf-mitigated'] === 'challenge';
}

/** Where a request that was put off picks up again: the hop the gate refused. */
export interface Resume {
  url: string;
  hop: number;
}

export type Requested =
  | { kind: 'later'; retryAfterMs: number; resume: Resume }
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
      /**
       * Whether no answer came to a request the gate let go: the network dropped it, it timed out,
       * or the HTTP client wouldn't send it, as it won't to the local network, where a redirect can
       * point, or when it couldn't sign it. The gate records each as a strain. A request the run
       * gave up waiting to send was never let go.
       */
      noAnswer: boolean;
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
    /** Where an attempt put off left off; without it, the request starts at its address. */
    resume?: Resume;
    maxBytes?: number;
    accept?: string;
  },
): Promise<Requested> {
  let url = options.resume?.url ?? address;
  let signals: ContentSignals = {};
  const failed = (
    error: string,
    more: { httpStatus?: number; noAnswer?: boolean } = {},
  ): Requested => ({
    kind: 'failed',
    error,
    httpStatus: more.httpStatus ?? null,
    noAnswer: more.noAnswer ?? false,
    url,
    signals,
  });

  for (let hop = options.resume?.hop ?? 0; ; hop += 1) {
    const decision = await ports.gate.reserve(url, {
      minIntervalMs: options.minIntervalMs,
      maxWaitMs: MAX_INLINE_WAIT_MS,
    });
    if (decision.kind === 'later') {
      if (!options.giveUp) {
        return { kind: 'later', retryAfterMs: decision.retryAfterMs, resume: { url, hop } };
      }
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
    if (!response.ok) return failed(response.error, { noAnswer: true });

    const location = response.headers.location;
    if (REDIRECTS.has(response.status) && location !== undefined) {
      const next = URL.canParse(location, url) ? new URL(location, url) : null;
      const httpStatus = response.status;
      if (next === null) {
        return failed(`redirected to ${location}, which isn’t an address`, { httpStatus });
      }
      if (next.protocol !== 'https:') {
        return failed(`redirected to ${next.href}, which isn’t HTTPS`, { httpStatus });
      }
      if (hop === MAX_REDIRECTS) {
        return failed(`redirected more than ${MAX_REDIRECTS} times`, { httpStatus });
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
