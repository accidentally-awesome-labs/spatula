import { isAllowed, parseRobots, type ContentSignals, type RobotsGroup } from './robots';

/*
 * The politeness each host gets, as pure functions of its state. HostGate, a Durable Object per
 * host, keeps the state and asks these before every request. robots.txt follows RFC 9309: a 4xx
 * means everything is allowed; a 5xx, a 429, or no answer means nothing is, until it recovers.
 * Requests to a host start at least a second apart, or further apart when robots.txt asks for a
 * crawl delay or the dataset for a longer interval. The interval counts from when the last answer
 * arrived, so a slow host isn't asked again sooner. After a 429, a 5xx, a block (401, 402, or
 * 403), or no answer, the host gets a break that doubles with each strain, or the longer one its
 * Retry-After asks for.
 */

export const PRODUCT_TOKEN = 'Spatula';

/** What a fetch came to. Failed and blocked fetches never change values. */
export const OUTCOMES = ['changed', 'unchanged', 'gone', 'failed', 'blocked'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN_INTERVAL_MS = 1000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;

export type RobotsRecord =
  | { status: 'ok'; fetchedAt: number; text: string }
  | { status: 'unavailable'; fetchedAt: number; httpStatus: number }
  | { status: 'unreachable'; fetchedAt: number; reason: string };

export interface GateState {
  robots: RobotsRecord | null;
  /** When the next request may start, in milliseconds since the epoch. */
  nextAt: number;
  /** The interval between this host's requests that the last reservation used. */
  intervalMs: number;
  /** No request starts before this, after the host showed strain. */
  backoffUntil: number;
  /** Strains in a row: 429s, 5xx answers, blocks, or no answers. */
  failures: number;
}

export const INITIAL_GATE_STATE: GateState = {
  robots: null,
  nextAt: 0,
  intervalMs: MIN_INTERVAL_MS,
  backoffUntil: 0,
  failures: 0,
};

export type GateDecision =
  | { kind: 'deny'; outcome: 'blocked' | 'failed'; reason: string }
  | { kind: 'later'; retryAfterMs: number; reason: string }
  | { kind: 'go'; waitMs: number; signals: ContentSignals };

/** robots.txt is read again after a day, or after an hour while it's unreachable. */
export function robotsNeedsRefresh(robots: RobotsRecord | null, now: number): boolean {
  if (robots === null) return true;
  return now - robots.fetchedAt >= (robots.status === 'unreachable' ? HOUR : DAY);
}

/** What an answer to a robots.txt request means, as RFC 9309 reads it. */
export function robotsRecord(
  response: { status: number; text: string } | { error: string },
  now: number,
): RobotsRecord {
  if ('error' in response) return { status: 'unreachable', fetchedAt: now, reason: response.error };
  const { status } = response;
  if (status >= 200 && status < 300) return { status: 'ok', fetchedAt: now, text: response.text };
  if (status >= 400 && status < 500 && status !== 429) {
    return { status: 'unavailable', fetchedAt: now, httpStatus: status };
  }
  return { status: 'unreachable', fetchedAt: now, reason: `HTTP ${status}` };
}

/** The interval a group's Crawl-delay and the dataset ask for, and never less than a second. */
function intervalOf(group: RobotsGroup | null, minIntervalMs: number): number {
  return Math.max(MIN_INTERVAL_MS, minIntervalMs, (group?.crawlDelaySeconds ?? 0) * 1000);
}

/**
 * The interval between requests to a host: a second at least, or longer when the dataset or the
 * host's robots.txt Crawl-delay asks for it.
 */
export function gateInterval(robots: RobotsRecord | null, minIntervalMs: number): number {
  const group = robots?.status === 'ok' ? parseRobots(robots.text, PRODUCT_TOKEN) : null;
  return intervalOf(group, minIntervalMs);
}

/**
 * Whether a request may go, and when. A wait longer than `maxWaitMs` comes back as `later`,
 * without reserving a slot, so the caller can sleep outside its step and ask again.
 */
export function reserve(
  state: GateState,
  request: { url: string; now: number; minIntervalMs: number; maxWaitMs: number },
): { state: GateState; decision: GateDecision } {
  const url = new URL(request.url);
  const { robots } = state;
  if (robots === null || robots.status === 'unreachable') {
    const why = robots === null ? '' : ` (${robots.reason})`;
    return {
      state,
      decision: {
        kind: 'deny',
        outcome: 'failed',
        reason: `robots.txt is unreachable${why}, so nothing on ${url.host} is fetched until it answers`,
      },
    };
  }
  const group = robots.status === 'ok' ? parseRobots(robots.text, PRODUCT_TOKEN) : null;
  if (!isAllowed(group, url)) {
    return {
      state,
      decision: {
        kind: 'deny',
        outcome: 'blocked',
        reason: `robots.txt disallows ${url.pathname}${url.search} for ${PRODUCT_TOKEN}`,
      },
    };
  }
  const start = Math.max(request.now, state.nextAt, state.backoffUntil);
  const waitMs = start - request.now;
  if (waitMs > request.maxWaitMs) {
    const reason =
      state.backoffUntil > request.now ? `${url.host} asked for a break` : `${url.host} is paced`;
    return { state, decision: { kind: 'later', retryAfterMs: waitMs, reason } };
  }
  const interval = intervalOf(group, request.minIntervalMs);
  return {
    state: { ...state, nextAt: start + interval, intervalMs: interval },
    decision: { kind: 'go', waitMs, signals: group?.signals ?? {} },
  };
}

/** Answers that ask a host's crawler to slow down or stop: too many requests, and blocks. */
const STRAINS = new Set([401, 402, 403, 429]);

/** The host's state after an answer. Status 0 means no answer: a timeout or a network error. */
export function recordResponse(
  state: GateState,
  response: { status: number; now: number; retryAfter: string | null },
): GateState {
  // A slow answer mustn't eat into the next request's wait: the interval counts from when the
  // answer arrived.
  const paced = { ...state, nextAt: Math.max(state.nextAt, response.now + state.intervalMs) };
  const strained = response.status === 0 || STRAINS.has(response.status) || response.status >= 500;
  if (!strained) return { ...paced, failures: 0 };
  const failures = state.failures + 1;
  // A Retry-After can lengthen the break, never shorten it: a host that keeps answering 429 with
  // a short one still gets a break that grows.
  const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  const delay = Math.max(backoff, retryAfterMs(response.retryAfter, response.now) ?? 0);
  return { ...paced, failures, backoffUntil: Math.max(state.backoffUntil, response.now + delay) };
}

/** A Retry-After header, in seconds or as an HTTP date, as milliseconds from now: at most an hour. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  const ms = /^\d+$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, HOUR) : null;
}
