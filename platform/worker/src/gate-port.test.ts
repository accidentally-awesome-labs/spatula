import type { GateState } from '@spatula/core';
import { describe, expect, it } from 'vitest';
import { Clock, fakeWeb, memoryGates } from '../test/node/fakes';
import { ROBOTS_OPEN } from '../test/pages';
import { createGatePort, GateKeeper } from './gate-port';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setUp() {
  const clock = new Clock(Date.UTC(2026, 9, 10));
  const web = fakeWeb(clock);
  const gates = memoryGates();
  const gate = createGatePort({ gateFor: gates.gateFor, http: web.http, now: () => clock.ms });
  return { clock, web, gate };
}

const request = { minIntervalMs: 1000, maxWaitMs: 15_000 };

describe('createGatePort', () => {
  it('reads robots.txt once a day, and paces the requests after it', async () => {
    const { clock, web, gate } = setUp();
    web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: ROBOTS_OPEN });
    // robots.txt was a request too, so the first page waits a second after it.
    expect(await gate.reserve('https://maker-a.example/products/a1', request)).toEqual({
      kind: 'go',
      waitMs: 1000,
      signals: {},
    });
    expect(await gate.reserve('https://maker-a.example/products/a2', request)).toMatchObject({
      kind: 'go',
      waitMs: 2000,
    });
    clock.advance(25 * HOUR);
    await gate.reserve('https://maker-a.example/products/a1', request);
    expect(web.requests.map((sent) => sent.url)).toEqual([
      'https://maker-a.example/robots.txt',
      'https://maker-a.example/robots.txt',
    ]);
  });

  it('follows robots.txt redirects, and fetches nothing while robots.txt fails', async () => {
    const { web, gate } = setUp();
    web.routes.set('https://maker-a.example/robots.txt', {
      status: 301,
      headers: { location: '/robots-live.txt' },
    });
    web.routes.set('https://maker-a.example/robots-live.txt', {
      status: 200,
      body: 'User-agent: *\nDisallow: /products/a2\n',
    });
    expect(await gate.reserve('https://maker-a.example/products/a2', request)).toMatchObject({
      kind: 'deny',
      outcome: 'blocked',
    });

    web.routes.set('https://maker-b.example/robots.txt', { status: 503 });
    expect(await gate.reserve('https://maker-b.example/products/b1', request)).toMatchObject({
      kind: 'deny',
      outcome: 'failed',
      reason: expect.stringContaining('robots.txt is unreachable (HTTP 503)'),
    });
  });

  it('treats a missing robots.txt as allowing everything', async () => {
    const { gate } = setUp();
    expect(await gate.reserve('https://maker-c.example/products/c1', request)).toMatchObject({
      kind: 'go',
    });
  });

  it('puts requests off while a strained host has its break', async () => {
    const { web, gate } = setUp();
    web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: ROBOTS_OPEN });
    await gate.reserve('https://maker-a.example/products/a1', request);
    await gate.record('https://maker-a.example/products/a1', { status: 503, retryAfter: null });
    expect(await gate.reserve('https://maker-a.example/products/a2', request)).toMatchObject({
      kind: 'later',
      retryAfterMs: 30_000,
    });
  });

  it('holds back a due robots.txt until the host’s break is over', async () => {
    const { clock, web, gate } = setUp();
    const robots = 'https://maker-a.example/robots.txt';
    web.routes.set(robots, { status: 200, body: ROBOTS_OPEN });
    const slow = { minIntervalMs: 15_000, maxWaitMs: 15_000 };
    await gate.reserve('https://maker-a.example/products/a1', slow);
    // robots.txt falls due five seconds after a page is answered with a 503, which gives the host a
    // break of thirty seconds.
    clock.advance(DAY - 5000);
    await gate.record('https://maker-a.example/products/a1', { status: 503, retryAfter: null });
    clock.advance(10_000);

    // It is due now, but it is a request like any other: it waits for the break, and isn't sent.
    const asked = web.requests.length;
    const held = await gate.reserve('https://maker-a.example/products/a2', slow);
    expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([]);
    expect(held).toEqual({
      kind: 'later',
      retryAfterMs: 20_000,
      reason: expect.stringContaining('maker-a.example'),
    });

    clock.advance(20_000);
    expect(await gate.reserve('https://maker-a.example/products/a2', slow)).toMatchObject({
      kind: 'go',
    });
    expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([robots]);
  });

  it('holds back a due robots.txt until the host’s turn, as it holds back a page', async () => {
    const { clock, web, gate } = setUp();
    const robots = 'https://maker-a.example/robots.txt';
    web.routes.set(robots, { status: 200, body: ROBOTS_OPEN });
    const slow = { minIntervalMs: 15_000, maxWaitMs: 15_000 };
    await gate.reserve('https://maker-a.example/products/a1', slow);
    // A page is reserved five seconds before robots.txt falls due, so the host's next turn comes
    // fifteen seconds after that, eight seconds after robots.txt is due.
    clock.advance(DAY - 5000);
    await gate.reserve('https://maker-a.example/products/a1', slow);
    clock.advance(7000);

    const asked = web.requests.length;
    const held = await gate.reserve('https://maker-a.example/products/a2', slow);
    expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([]);
    expect(held).toMatchObject({ kind: 'later', retryAfterMs: 8000 });

    clock.advance(8000);
    await gate.reserve('https://maker-a.example/products/a2', slow);
    expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([robots]);
  });
});

describe('a robots.txt that meets a challenge', () => {
  const robots = 'https://maker-a.example/robots.txt';
  const challenge = { status: 403, headers: { 'cf-mitigated': 'challenge' } };
  const strict = 'User-agent: *\nDisallow: /private\nCrawl-delay: 5\n';

  it('keeps the rules it holds, crawl delay included, and reads it again in an hour', async () => {
    const { clock, web, gate } = setUp();
    web.routes.set(robots, { status: 200, body: strict });
    await gate.reserve('https://maker-a.example/products/a1', request);
    // A day later the refresh is challenged. The host is refusing Spatula, not saying it has no
    // rules.
    clock.advance(25 * HOUR);
    web.routes.set(robots, challenge);
    const asked = web.requests.length;
    expect(await gate.reserve('https://maker-a.example/private/x', request)).toMatchObject({
      kind: 'deny',
      outcome: 'blocked',
    });
    expect(await gate.reserve('https://maker-a.example/products/a2', request)).toMatchObject({
      kind: 'go',
      waitMs: 5000,
    });
    expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([robots]);

    // It isn't asked for again before the hour is out, and then it is read as usual.
    clock.advance(HOUR - 60_000);
    await gate.reserve('https://maker-a.example/products/a3', request);
    expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([robots]);
    web.routes.set(robots, { status: 200, body: ROBOTS_OPEN });
    clock.advance(120_000);
    expect(await gate.reserve('https://maker-a.example/private/x', request)).toMatchObject({
      kind: 'go',
    });
    expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([robots, robots]);
  });

  it.each([403, 503, 200])(
    'refuses a host it holds nothing for, whatever the %i it was answered with, and reads it again in an hour',
    async (status) => {
      const { clock, web, gate } = setUp();
      // The header decides, not the status: a challenge page can come with a 200.
      web.routes.set(robots, { ...challenge, status, body: '<html>Just a moment…</html>' });
      expect(await gate.reserve('https://maker-a.example/products/a1', request)).toEqual({
        kind: 'deny',
        outcome: 'failed',
        reason:
          'robots.txt is unreachable (the site answered robots.txt with a challenge), so nothing on maker-a.example is fetched until it answers',
        // The gate says the challenge is why, which the run reads as a refusal (ADR 0006).
        robotsChallenged: true,
      });
      const asked = web.requests.length;
      clock.advance(HOUR - 60_000);
      expect(await gate.reserve('https://maker-a.example/products/a1', request)).toMatchObject({
        kind: 'deny',
        outcome: 'failed',
      });
      expect(web.requests).toHaveLength(asked);

      web.routes.set(robots, { status: 200, body: ROBOTS_OPEN });
      clock.advance(120_000);
      expect(await gate.reserve('https://maker-a.example/products/a1', request)).toMatchObject({
        kind: 'go',
      });
      expect(web.requests.slice(asked).map((sent) => sent.url)).toEqual([robots]);
    },
  );

  it('still reads a 4xx without a challenge as no rules at all, as RFC 9309 does', async () => {
    const { clock, web, gate } = setUp();
    web.routes.set(robots, { status: 200, body: strict });
    await gate.reserve('https://maker-a.example/products/a1', request);
    clock.advance(25 * HOUR);
    web.routes.set(robots, { status: 403 });
    expect(await gate.reserve('https://maker-a.example/private/x', request)).toEqual({
      kind: 'go',
      waitMs: 1000,
      signals: {},
    });
  });
});

describe('GateKeeper', () => {
  it('reads a state saved before slice 1, which has no interval', async () => {
    let saved: unknown = { robots: null, nextAt: 0, backoffUntil: 0, failures: 0 };
    const keeper = new GateKeeper({
      load: async () => saved as GateState,
      save: async (state) => {
        saved = state;
      },
    });
    // An answer to a request reserved before the deploy: without the default interval, nextAt
    // would be NaN, and the host would go unpaced for good.
    await keeper.record({ status: 200, now: 16_000, retryAfter: null });
    expect(saved).toMatchObject({ intervalMs: 1000, nextAt: 17_000 });
  });

  it('paces each answer by the interval its reservation chose', async () => {
    let saved: unknown = { robots: null, nextAt: 0, backoffUntil: 0, failures: 0 };
    const keeper = new GateKeeper({
      load: async () => saved as GateState,
      save: async (state) => {
        saved = state;
      },
    });
    await keeper.storeRobots({ status: 'ok', fetchedAt: 0, text: ROBOTS_OPEN }, 0, 15_000);
    await keeper.reserve({
      url: 'https://maker-a.example/a',
      now: 15_000,
      minIntervalMs: 15_000,
      maxWaitMs: 15_000,
    });
    await keeper.record({ status: 200, now: 16_000, retryAfter: null });
    expect(saved).toMatchObject({ intervalMs: 15_000, nextAt: 31_000 });
  });

  it('waits the dataset’s interval after reading robots.txt', async () => {
    const { web, gate } = setUp();
    web.routes.set('https://maker-a.example/robots.txt', { status: 200, body: ROBOTS_OPEN });
    expect(
      await gate.reserve('https://maker-a.example/products/a1', {
        minIntervalMs: 15_000,
        maxWaitMs: 15_000,
      }),
    ).toEqual({ kind: 'go', waitMs: 15_000, signals: {} });
  });
});
