import { describe, expect, it } from 'vitest';
import {
  gateInterval,
  INITIAL_GATE_STATE,
  recordResponse,
  reserve,
  retryAfterMs,
  robotsNeedsRefresh,
  robotsRecord,
  robotsRefused,
  robotsToKeep,
  type GateState,
  type RobotsRecord,
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

  it('keep the status that left them unreachable, and none for an error or a challenge', () => {
    expect(robotsRecord({ status: 429, text: '' }, NOW)).toMatchObject({
      status: 'unreachable',
      reason: 'HTTP 429',
      httpStatus: 429,
    });
    expect(robotsRecord({ status: 503, text: '' }, NOW)).toMatchObject({ httpStatus: 503 });
    expect(robotsRecord({ error: 'TimeoutError' }, NOW)).not.toHaveProperty('httpStatus');
    expect(robotsRecord({ challenged: true }, NOW)).not.toHaveProperty('httpStatus');
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

describe('a robots.txt refresh that meets a challenge', () => {
  const challenged = robotsRecord({ challenged: true }, NOW);
  const held = robotsRecord(
    { status: 200, text: 'User-agent: *\nDisallow: /private\nCrawl-delay: 5\n' },
    NOW - 25 * HOUR,
  );

  it('reads as unreachable, which refuses everything until it is read again in an hour', () => {
    expect(challenged).toEqual({
      status: 'unreachable',
      fetchedAt: NOW,
      reason: 'the site answered robots.txt with a challenge',
      challengedAt: NOW,
    });
    expect(robotsNeedsRefresh(challenged, NOW + HOUR - 1)).toBe(false);
    expect(robotsNeedsRefresh(challenged, NOW + HOUR)).toBe(true);
  });

  it('leaves the rules held in force, crawl delay included, and tries again in an hour', () => {
    const kept = robotsToKeep(held, challenged);
    expect(kept).toEqual({ ...held, challengedAt: NOW });
    const state: GateState = { ...INITIAL_GATE_STATE, robots: kept };
    expect(reserve(state, request('https://maker.example/private/x')).decision).toMatchObject({
      kind: 'deny',
      outcome: 'blocked',
    });
    expect(gateInterval(kept, 0)).toBe(5000);
    // It was read a day ago, so without the challenge it would be due now.
    expect(robotsNeedsRefresh(held, NOW)).toBe(true);
    expect(robotsNeedsRefresh(kept, NOW + HOUR - 1)).toBe(false);
    expect(robotsNeedsRefresh(kept, NOW + HOUR)).toBe(true);
  });

  it('replaces nothing but what it must: with no record held it is the record, and any other answer replaces', () => {
    expect(robotsToKeep(null, challenged)).toEqual(challenged);
    const none = robotsRecord({ status: 404, text: '' }, NOW);
    expect(robotsToKeep(held, none)).toEqual(none);
  });

  it('leaves a record that holds no rules to the challenge: a denial names it, not the outage', () => {
    // Nothing is in force to keep, and keeping the outage would have every denial say HTTP 503
    // while the host is refusing.
    const down = robotsRecord({ status: 503, text: '' }, NOW - 2 * HOUR);
    const kept = robotsToKeep(down, challenged);
    expect(kept).toEqual(challenged);
    const { decision } = reserve(
      { ...INITIAL_GATE_STATE, robots: kept },
      request('https://maker.example/a'),
    );
    expect(decision).toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('the site answered robots.txt with a challenge'),
    });
    expect(decision).not.toMatchObject({ reason: expect.stringContaining('HTTP 503') });
    // The next read is due when it was: an hour after the challenge, as with the outage kept.
    expect(robotsNeedsRefresh(kept, NOW + HOUR - 1)).toBe(false);
    expect(robotsNeedsRefresh(kept, NOW + HOUR)).toBe(true);
    const outageKept = { ...down, challengedAt: NOW };
    expect(robotsNeedsRefresh(outageKept, NOW + HOUR - 1)).toBe(false);
    expect(robotsNeedsRefresh(outageKept, NOW + HOUR)).toBe(true);
  });

  it('leaves a record that says there are no rules in force too', () => {
    const none = robotsRecord({ status: 404, text: '' }, NOW - 25 * HOUR);
    expect(robotsToKeep(none, challenged)).toEqual({ ...none, challengedAt: NOW });
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

  it.each([
    [401, true],
    [403, true],
    [410, false],
  ])(
    'allows everything when robots.txt answered %i, and says whether it refused',
    (status, refused) => {
      const state: GateState = {
        ...INITIAL_GATE_STATE,
        robots: robotsRecord({ status, text: '' }, NOW),
      };
      expect(reserve(state, request('https://maker.example/anything')).decision).toEqual({
        kind: 'go',
        waitMs: 0,
        signals: {},
        ...(refused ? { robotsRefused: true } : {}),
      });
    },
  );

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

describe('robotsRefused', () => {
  const answers: [string, RobotsRecord | null, boolean][] = [
    ['rules', robotsRecord({ status: 200, text: 'User-agent: *' }, NOW), false],
    ['a 404', robotsRecord({ status: 404, text: '' }, NOW), false],
    ['a 410', robotsRecord({ status: 410, text: '' }, NOW), false],
    ['a 401', robotsRecord({ status: 401, text: '' }, NOW), true],
    ['a 402', robotsRecord({ status: 402, text: '' }, NOW), true],
    ['a 403', robotsRecord({ status: 403, text: '' }, NOW), true],
    ['a 429', robotsRecord({ status: 429, text: '' }, NOW), true],
    ['a 503', robotsRecord({ status: 503, text: '' }, NOW), false],
    ['a network error', robotsRecord({ error: 'TimeoutError' }, NOW), false],
    ['a challenge', robotsRecord({ challenged: true }, NOW), true],
    // Durable Object state from before the status was kept: not refusing until it is read again.
    [
      'a 429 kept without its status',
      { status: 'unreachable', fetchedAt: NOW, reason: 'HTTP 429' },
      false,
    ],
    ['nothing read yet', null, false],
  ];

  it.each(answers)('reads robots.txt after %s as refusing: %s', (_answer, robots, expected) => {
    expect(robotsRefused(robots)).toBe(expected);
  });

  it('keeps a challenge against the host while rules stay in force, until it is read again', () => {
    const rules = 'User-agent: *\nDisallow: /private\n';
    const held = robotsRecord({ status: 200, text: rules }, NOW - 25 * HOUR);
    const kept = robotsToKeep(held, robotsRecord({ challenged: true }, NOW));
    expect(kept.status).toBe('ok');
    expect(robotsRefused(kept)).toBe(true);
    const again = robotsRecord({ status: 200, text: rules }, NOW + HOUR);
    expect(robotsRefused(robotsToKeep(kept, again))).toBe(false);
  });
});

describe('a host whose robots.txt refuses Spatula', () => {
  const rules = 'User-agent: *\nDisallow: /private\n';
  const stateOf = (robots: RobotsRecord): GateState => ({ ...INITIAL_GATE_STATE, robots });
  const asking = (path = '/p') => request(`https://maker.example${path}`);

  it.each([
    ['a 429', robotsRecord({ status: 429, text: '' }, NOW)],
    ['a challenge', robotsRecord({ challenged: true }, NOW)],
  ])('holds requests back, and says robots.txt refused, after %s', (_answer, robots) => {
    expect(reserve(stateOf(robots), asking()).decision).toMatchObject({
      kind: 'deny',
      outcome: 'failed',
      robotsRefused: true,
    });
  });

  it.each([401, 402, 403])(
    'lets requests go, and says robots.txt refused, after a %i',
    (status) => {
      const robots = robotsRecord({ status, text: '' }, NOW);
      expect(reserve(stateOf(robots), asking()).decision).toEqual({
        kind: 'go',
        waitMs: 0,
        signals: {},
        robotsRefused: true,
      });
    },
  );

  it('says it when it puts a request off too, and only for a host that refused', () => {
    const refused = robotsRecord({ status: 403, text: '' }, NOW);
    const resting = { backoffUntil: NOW + 60_000 };
    expect(reserve({ ...stateOf(refused), ...resting }, asking()).decision).toEqual({
      kind: 'later',
      retryAfterMs: 60_000,
      reason: 'maker.example asked for a break',
      robotsRefused: true,
    });
    const answered = robotsRecord({ status: 404, text: '' }, NOW);
    expect(reserve({ ...stateOf(answered), ...resting }, asking()).decision).not.toHaveProperty(
      'robotsRefused',
    );
  });

  it('says it after a challenge for what the rules held allow, and for what they disallow', () => {
    const held = robotsRecord({ status: 200, text: rules }, NOW - 25 * HOUR);
    const challenged = stateOf(robotsToKeep(held, robotsRecord({ challenged: true }, NOW)));
    expect(reserve(challenged, asking('/p')).decision).toMatchObject({
      kind: 'go',
      robotsRefused: true,
    });
    expect(reserve(challenged, asking('/private/x')).decision).toMatchObject({
      kind: 'deny',
      outcome: 'blocked',
      robotsRefused: true,
    });
  });

  it.each([
    ['rules that allow the page', robotsRecord({ status: 200, text: rules }, NOW), '/p'],
    ['rules that disallow it', robotsRecord({ status: 200, text: rules }, NOW), '/private/x'],
    ['a 404', robotsRecord({ status: 404, text: '' }, NOW), '/p'],
    ['a 410', robotsRecord({ status: 410, text: '' }, NOW), '/p'],
    ['a 503', robotsRecord({ status: 503, text: '' }, NOW), '/p'],
    ['a network error', robotsRecord({ error: 'the network dropped it' }, NOW), '/p'],
  ])('says nothing of a refusal after %s', (_answer, robots, path) => {
    expect(reserve(stateOf(robots), asking(path)).decision).not.toHaveProperty('robotsRefused');
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
      nextAt: NOW + 1000,
    });
  });

  it.each([401, 402])('counts a %i as a strain', (status) => {
    expect(recordResponse(INITIAL_GATE_STATE, { status, now: NOW, retryAfter: null })).toEqual({
      ...INITIAL_GATE_STATE,
      failures: 1,
      backoffUntil: NOW + 30_000,
      nextAt: NOW + 1000,
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
      nextAt: NOW + 1001,
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

describe('pacing from each answer', () => {
  const open: GateState = {
    ...INITIAL_GATE_STATE,
    robots: { status: 'ok', fetchedAt: 0, text: 'User-agent: *\nAllow: /\n' },
  };
  const request = (now: number) => ({
    url: 'https://maker-a.example/products/a1',
    now,
    minIntervalMs: 15_000,
    maxWaitMs: 15_000,
  });

  it('waits a full interval after a slow answer arrives, not after its request left', () => {
    const first = reserve(open, request(1000));
    expect(first.state).toMatchObject({ nextAt: 16_000, intervalMs: 15_000 });
    // The answer took eight seconds.
    const answered = recordResponse(first.state, { status: 200, now: 9000, retryAfter: null });
    expect(answered.nextAt).toBe(24_000);
    expect(reserve(answered, request(9000)).decision).toEqual({
      kind: 'go',
      waitMs: 15_000,
      signals: {},
    });
  });

  it('keeps the crawl delay robots.txt asks for, when it’s longer', () => {
    const slow: GateState = {
      ...open,
      robots: { status: 'ok', fetchedAt: 0, text: 'User-agent: *\nCrawl-delay: 20\n' },
    };
    const first = reserve(slow, request(0));
    expect(recordResponse(first.state, { status: 200, now: 500, retryAfter: null }).nextAt).toBe(
      20_500,
    );
    expect(gateInterval(slow.robots, 15_000)).toBe(20_000);
    expect(gateInterval(null, 0)).toBe(1000);
  });
});
