import { describe, expect, it } from 'vitest';
import {
  INITIAL_GATE_STATE,
  recordResponse,
  reserve,
  retryAfterMs,
  robotsNeedsRefresh,
  robotsRecord,
  type GateState,
} from './gate';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const HOUR = 3_600_000;
const request = (url: string, now = NOW) => ({ url, now, minIntervalMs: 1000, maxWaitMs: 15_000 });
const withRobots = (text: string): GateState => ({
  ...INITIAL_GATE_STATE,
  robots: { status: 'ok', fetchedAt: NOW, text },
});

describe('robots.txt answers', () => {
  it('reads 2xx as rules, other 4xx as everything allowed, and 429, 5xx, or no answer as nothing allowed', () => {
    expect(robotsRecord({ status: 200, text: 'User-agent: *' }, NOW)).toEqual({
      status: 'ok',
      fetchedAt: NOW,
      text: 'User-agent: *',
    });
    expect(robotsRecord({ status: 404, text: '' }, NOW)).toMatchObject({ status: 'unavailable' });
    expect(robotsRecord({ status: 429, text: '' }, NOW)).toMatchObject({ status: 'unreachable' });
    expect(robotsRecord({ status: 503, text: '' }, NOW)).toMatchObject({ status: 'unreachable' });
    expect(robotsRecord({ error: 'TimeoutError' }, NOW)).toMatchObject({
      status: 'unreachable',
      reason: 'TimeoutError',
    });
  });

  it('are kept a day, or an hour while unreachable', () => {
    expect(robotsNeedsRefresh(null, NOW)).toBe(true);
    const ok = robotsRecord({ status: 200, text: '' }, NOW);
    expect(robotsNeedsRefresh(ok, NOW + 23 * HOUR)).toBe(false);
    expect(robotsNeedsRefresh(ok, NOW + 24 * HOUR)).toBe(true);
    const down = robotsRecord({ status: 503, text: '' }, NOW);
    expect(robotsNeedsRefresh(down, NOW + HOUR - 1)).toBe(false);
    expect(robotsNeedsRefresh(down, NOW + HOUR)).toBe(true);
  });
});

describe('reserve', () => {
  it('fetches nothing while robots.txt is unreachable', () => {
    const state: GateState = {
      ...INITIAL_GATE_STATE,
      robots: robotsRecord({ status: 503, text: '' }, NOW),
    };
    const { decision } = reserve(state, request('https://maker.example/products/a'));
    expect(decision).toMatchObject({ kind: 'deny', outcome: 'failed' });
  });

  it('denies what robots.txt disallows, as blocked', () => {
    const { decision } = reserve(
      withRobots('User-agent: *\nDisallow: /private'),
      request('https://maker.example/private/x'),
    );
    expect(decision).toEqual({
      kind: 'deny',
      outcome: 'blocked',
      reason: 'robots.txt disallows /private/x for Spatula',
    });
  });

  it('allows everything when robots.txt answered 4xx', () => {
    const state: GateState = {
      ...INITIAL_GATE_STATE,
      robots: robotsRecord({ status: 404, text: '' }, NOW),
    };
    expect(reserve(state, request('https://maker.example/anything')).decision).toEqual({
      kind: 'go',
      waitMs: 0,
      signals: {},
    });
  });

  it('spaces requests a second apart, or by the crawl delay or the dataset if longer', () => {
    const first = reserve(
      withRobots('User-agent: *\nAllow: /'),
      request('https://maker.example/a'),
    );
    expect(first.decision).toMatchObject({ kind: 'go', waitMs: 0 });
    expect(first.state.nextAt).toBe(NOW + 1000);
    const second = reserve(first.state, request('https://maker.example/b'));
    expect(second.decision).toMatchObject({ kind: 'go', waitMs: 1000 });
    expect(second.state.nextAt).toBe(NOW + 2000);

    const slow = reserve(
      withRobots('User-agent: *\nCrawl-delay: 5'),
      request('https://maker.example/a'),
    );
    expect(slow.state.nextAt).toBe(NOW + 5000);
    const patient = reserve(withRobots(''), {
      ...request('https://maker.example/a'),
      minIntervalMs: 2000,
    });
    expect(patient.state.nextAt).toBe(NOW + 2000);
  });

  it('asks the caller to come back later instead of waiting long, and reserves nothing', () => {
    const state: GateState = { ...withRobots(''), backoffUntil: NOW + 60_000 };
    const { decision, state: after } = reserve(state, request('https://maker.example/a'));
    expect(decision).toMatchObject({ kind: 'later', retryAfterMs: 60_000 });
    expect(after).toEqual(state);
  });

  it('passes on the content signals that apply', () => {
    const { decision } = reserve(
      withRobots('User-agent: *\nContent-Signal: ai-input=no'),
      request('https://maker.example/a'),
    );
    expect(decision).toMatchObject({ kind: 'go', signals: { 'ai-input': 'no' } });
  });

  it('fetches nothing before robots.txt has been read, and says why', () => {
    expect(reserve(INITIAL_GATE_STATE, request('https://maker.example/a'))).toEqual({
      state: INITIAL_GATE_STATE,
      decision: {
        kind: 'deny',
        outcome: 'failed',
        reason:
          'robots.txt is unreachable, so nothing on maker.example is fetched until it answers',
      },
    });
    const down: GateState = {
      ...INITIAL_GATE_STATE,
      robots: robotsRecord({ status: 503, text: '' }, NOW),
    };
    expect(reserve(down, request('https://maker.example/a')).decision).toEqual({
      kind: 'deny',
      outcome: 'failed',
      reason:
        'robots.txt is unreachable (HTTP 503), so nothing on maker.example is fetched until it answers',
    });
  });

  it.each([401, 403, 410])('allows everything when robots.txt answered %i', (status) => {
    const state: GateState = {
      ...INITIAL_GATE_STATE,
      robots: robotsRecord({ status, text: '' }, NOW),
    };
    expect(reserve(state, request('https://maker.example/anything')).decision).toEqual({
      kind: 'go',
      waitMs: 0,
      signals: {},
    });
  });

  it('spaces requests at least a second apart, even when the dataset asks for no interval', () => {
    const { state } = reserve(withRobots(''), {
      ...request('https://maker.example/a'),
      minIntervalMs: 0,
    });
    expect(state.nextAt).toBe(NOW + 1000);
  });

  it('waits as long as the caller allows, and no longer', () => {
    const atLimit = reserve(
      { ...withRobots(''), nextAt: NOW + 15_000 },
      request('https://maker.example/a'),
    );
    expect(atLimit.decision).toMatchObject({ kind: 'go', waitMs: 15_000 });
    expect(atLimit.state.nextAt).toBe(NOW + 16_000);
    const pastLimit = reserve(
      { ...withRobots(''), nextAt: NOW + 15_001 },
      request('https://maker.example/a'),
    );
    expect(pastLimit.decision).toEqual({
      kind: 'later',
      retryAfterMs: 15_001,
      reason: 'maker.example is paced',
    });
  });

  it('says a host asked for a break when its backoff is what the caller would wait for', () => {
    const state: GateState = { ...withRobots(''), backoffUntil: NOW + 60_000 };
    expect(reserve(state, request('https://maker.example/a')).decision).toEqual({
      kind: 'later',
      retryAfterMs: 60_000,
      reason: 'maker.example asked for a break',
    });
  });

  it('never changes the state it is given', () => {
    // Any write to a frozen object throws, because these modules run in strict mode.
    const frozen = (state: GateState): GateState => {
      if (state.robots !== null) Object.freeze(state.robots);
      return Object.freeze(state);
    };
    const paced = frozen({ ...withRobots(''), nextAt: NOW + 60_000 });
    expect(reserve(paced, request('https://maker.example/a'))).toMatchObject({
      state: paced,
      decision: { kind: 'later' },
    });
    expect(paced.nextAt).toBe(NOW + 60_000);
    const open = frozen(withRobots(''));
    expect(reserve(open, request('https://maker.example/a')).decision).toMatchObject({
      kind: 'go',
    });
    expect(open.nextAt).toBe(0);
    const strained = recordResponse(open, { status: 429, now: NOW, retryAfter: '0' });
    expect(strained.failures).toBe(1);
    expect(open).toEqual(withRobots(''));
  });
});

describe('recordResponse', () => {
  it('backs off on 429, 5xx, blocks, and no answer, doubling each time up to ten minutes', () => {
    let state = recordResponse(INITIAL_GATE_STATE, { status: 429, now: NOW, retryAfter: null });
    expect(state).toMatchObject({ failures: 1, backoffUntil: NOW + 30_000 });
    state = recordResponse(state, { status: 503, now: NOW, retryAfter: null });
    expect(state).toMatchObject({ failures: 2, backoffUntil: NOW + 60_000 });
    state = recordResponse(state, { status: 0, now: NOW, retryAfter: null });
    expect(state.failures).toBe(3);
    state = recordResponse(state, { status: 403, now: NOW, retryAfter: null });
    expect(state).toMatchObject({ failures: 4, backoffUntil: NOW + 240_000 });
    for (let i = 0; i < 10; i += 1)
      state = recordResponse(state, { status: 500, now: NOW, retryAfter: null });
    expect(state.backoffUntil).toBe(NOW + 600_000);
  });

  it('follows Retry-After, up to an hour', () => {
    expect(
      recordResponse(INITIAL_GATE_STATE, { status: 429, now: NOW, retryAfter: '120' }).backoffUntil,
    ).toBe(NOW + 120_000);
    expect(
      recordResponse(INITIAL_GATE_STATE, { status: 503, now: NOW, retryAfter: '86400' })
        .backoffUntil,
    ).toBe(NOW + HOUR);
  });

  it('keeps growing the break when Retry-After asks for less', () => {
    let state = INITIAL_GATE_STATE;
    const breaks: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      state = recordResponse(state, { status: 429, now: NOW, retryAfter: '0' });
      breaks.push(state.backoffUntil - NOW);
    }
    expect(breaks).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(state.failures).toBe(4);
  });

  it('keeps a longer break it already has when a short Retry-After arrives', () => {
    const resting: GateState = { ...INITIAL_GATE_STATE, failures: 1, backoffUntil: NOW + HOUR };
    expect(recordResponse(resting, { status: 429, now: NOW, retryAfter: '5' })).toEqual({
      ...resting,
      failures: 2,
      backoffUntil: NOW + HOUR,
    });
  });

  it.each([401, 402])('counts a %i as a strain', (status) => {
    expect(recordResponse(INITIAL_GATE_STATE, { status, now: NOW, retryAfter: null })).toEqual({
      ...INITIAL_GATE_STATE,
      failures: 1,
      backoffUntil: NOW + 30_000,
    });
  });

  it('clears the failure count on any other answer, and keeps an earlier backoff', () => {
    const strained = recordResponse(INITIAL_GATE_STATE, {
      status: 429,
      now: NOW,
      retryAfter: null,
    });
    expect(recordResponse(strained, { status: 200, now: NOW + 1, retryAfter: null })).toEqual({
      ...strained,
      failures: 0,
    });
  });
});

describe('retryAfterMs', () => {
  it('reads seconds or an HTTP date', () => {
    expect(retryAfterMs('30', NOW)).toBe(30_000);
    expect(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(retryAfterMs('soon', NOW)).toBeNull();
    expect(retryAfterMs(null, NOW)).toBeNull();
  });
});
