import type { GateState } from '@spatula/core';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { HostGate } from '../../src/host-gate';

const NOW = Date.UTC(2026, 9, 10);
const gateFor = (host: string) => env.HOST_GATE.get(env.HOST_GATE.idFromName(host));
const request = (url: string, now = NOW) => ({ url, now, minIntervalMs: 1000, maxWaitMs: 15_000 });

describe('HostGate', () => {
  it('keeps a host’s robots.txt and pacing in its storage', async () => {
    const gate = gateFor('gate-pacing.example');
    expect(await gate.robotsDue(NOW)).toBe(true);
    await gate.storeRobots(
      { status: 'ok', fetchedAt: NOW, text: 'User-agent: *\nAllow: /\n' },
      NOW,
    );
    expect(await gate.robotsDue(NOW)).toBe(false);

    expect(await gate.reserve(request('https://gate-pacing.example/a'))).toEqual({
      kind: 'go',
      waitMs: 1000,
      signals: {},
    });
    expect(await gate.reserve(request('https://gate-pacing.example/b'))).toMatchObject({
      kind: 'go',
      waitMs: 2000,
    });

    const stored = await runInDurableObject(gate, async (_gate: HostGate, state) =>
      state.storage.get<GateState>('state'),
    );
    expect(stored).toMatchObject({ robots: { status: 'ok' }, nextAt: NOW + 3000, failures: 0 });
  });

  it('refuses what robots.txt disallows, and everything while robots.txt is unreachable', async () => {
    const strict = gateFor('gate-strict.example');
    await strict.storeRobots(
      { status: 'ok', fetchedAt: NOW, text: 'User-agent: Spatula\nDisallow: /private\n' },
      NOW,
    );
    expect(await strict.reserve(request('https://gate-strict.example/private/a'))).toMatchObject({
      kind: 'deny',
      outcome: 'blocked',
    });

    const down = gateFor('gate-down.example');
    await down.storeRobots({ status: 'unreachable', fetchedAt: NOW, reason: 'HTTP 503' }, NOW);
    expect(await down.reserve(request('https://gate-down.example/a'))).toMatchObject({
      kind: 'deny',
      outcome: 'failed',
    });
  });

  it('gives a strained host a break', async () => {
    const gate = gateFor('gate-strained.example');
    await gate.storeRobots({ status: 'unavailable', fetchedAt: NOW, httpStatus: 404 }, NOW);
    await gate.reserve(request('https://gate-strained.example/a'));
    await gate.record({ status: 429, now: NOW, retryAfter: '120' });
    expect(await gate.reserve(request('https://gate-strained.example/b'))).toMatchObject({
      kind: 'later',
      retryAfterMs: 120_000,
    });
  });

  it('keeps a robots.txt as large as the fetcher allows', async () => {
    // The fetcher reads up to 512 KiB of a robots.txt, and the gate keeps all of it, text included,
    // as one stored value. This proves the code path only: local workerd doesn't enforce
    // production's limit on a stored value, so the first deployed run is what shows it fits.
    let text = 'User-agent: *\nAllow: /\n';
    while (text.length <= 512 * 1024) text += `# ${'x'.repeat(78)}\n`;

    const gate = gateFor('gate-large.example');
    await gate.storeRobots({ status: 'ok', fetchedAt: NOW, text }, NOW);
    expect(await gate.reserve(request('https://gate-large.example/a'))).toMatchObject({
      kind: 'go',
    });
  });

  it('gives concurrent callers different slots', async () => {
    const gate = gateFor('gate-concurrent.example');
    await gate.storeRobots(
      { status: 'ok', fetchedAt: NOW, text: 'User-agent: *\nAllow: /\n' },
      NOW,
    );

    // Five runs ask for the same host at the same moment. The object's input gate holds each call
    // while it reads and writes the host's state, so no two of them can take the same slot.
    const decisions = await Promise.all(
      [1, 2, 3, 4, 5].map((page) =>
        gate.reserve(request(`https://gate-concurrent.example/${page}`)),
      ),
    );

    // The first slot is a second out, not now: storing robots.txt counts as a request, so the
    // host's next one starts a second after it. Each later slot is one pacing interval (a second)
    // after the one before. The calls may be served in any order, so the waits are sorted.
    expect(decisions.map((decision) => decision.kind)).toEqual(['go', 'go', 'go', 'go', 'go']);
    const waits = decisions.map((decision) => (decision.kind === 'go' ? decision.waitMs : -1));
    expect(waits.sort((a, b) => a - b)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });
});
