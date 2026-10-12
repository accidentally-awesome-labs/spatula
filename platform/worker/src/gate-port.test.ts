import type { GateState } from '@spatula/core';
import { describe, expect, it } from 'vitest';
import { Clock, fakeWeb, memoryGates } from '../test/node/fakes';
import { ROBOTS_OPEN } from '../test/pages';
import { createGatePort, GateKeeper } from './gate-port';

const HOUR = 3_600_000;

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
