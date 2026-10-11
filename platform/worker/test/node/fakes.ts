import { INITIAL_GATE_STATE, type GateState, type LlmPort } from '@spatula/core';
import { packs } from '@spatula/pack-products';
import type { Executor } from '@spatula/store';
import { createGatePort, GateKeeper } from '../../src/gate-port';
import type { HttpPort, RefreshPorts, StepRunner } from '../../src/refresh';
import { answerFor, type Reply } from '../pages';

/** Time that moves only when told: by waits, sleeps, and each request's 100 ms. */
export class Clock {
  constructor(public ms: number) {}
  now = () => new Date(this.ms);
  advance = (ms: number) => {
    this.ms += ms;
  };
}

/** Runs steps at once, in order. Results go through JSON, as Workflows keep them. */
export function fakeStep(clock: Clock) {
  const names: string[] = [];
  const step: StepRunner = {
    async do(name, fn) {
      if (names.includes(name)) throw new Error(`Step ${name} ran twice`);
      names.push(name);
      const result = await fn();
      return result === undefined ? result : JSON.parse(JSON.stringify(result));
    },
    async sleep(name, ms) {
      names.push(name);
      clock.advance(ms);
    },
  };
  return { step, names };
}

/** A small web: each address answers as its route says, or 404. Every request is logged. */
export function fakeWeb(clock: Clock) {
  const routes = new Map<string, Reply>();
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const http: HttpPort = {
    async get(url, headers) {
      requests.push({ url, headers });
      clock.advance(100);
      const reply = routes.get(url) ?? { status: 404 };
      const ok = reply.status >= 200 && reply.status < 300;
      return {
        ok: true,
        status: reply.status,
        headers: { 'content-type': 'text/html; charset=utf-8', ...reply.headers },
        body: ok ? new TextEncoder().encode(reply.body ?? '') : new Uint8Array(),
        truncated: false,
      };
    },
  };
  return { http, routes, requests };
}

/** Each host's gate state in memory, through the same GateKeeper the Durable Object uses. */
export function memoryGates() {
  const states = new Map<string, GateState>();
  return {
    states,
    gateFor: (host: string) =>
      new GateKeeper({
        load: async () => states.get(host) ?? INITIAL_GATE_STATE,
        save: async (state) => {
          states.set(host, state);
        },
      }),
  };
}

/** An LLM that answers from a table, checks its answer against the schema, and counts calls. */
export function fakeLlm(answer: (user: string) => Record<string, unknown> | null) {
  const calls: string[] = [];
  const llm: LlmPort = {
    model: 'test-model',
    async structured(request) {
      calls.push(request.user);
      const proposed = answer(request.user);
      const parsed = proposed === null ? null : request.schema.safeParse(proposed);
      return {
        output: parsed?.success ? parsed.data : null,
        usage: { inputTokens: 1000, outputTokens: 50 },
      };
    },
  };
  return { llm, calls };
}

/** Everything a refresh touches, faked, around a real database. State lasts across runs. */
export function makeWorld(
  db: Executor,
  routes: Record<string, Reply>,
  options: { llm?: boolean } = {},
) {
  const clock = new Clock(Date.UTC(2026, 9, 10));
  const web = fakeWeb(clock);
  for (const [url, reply] of Object.entries(routes)) web.routes.set(url, reply);
  const gates = memoryGates();
  const stored = new Map<string, Uint8Array>();
  const llm = fakeLlm(answerFor);
  const ports: RefreshPorts = {
    withDb: (fn) => fn(db),
    gate: createGatePort({ gateFor: gates.gateFor, http: web.http, now: () => clock.ms }),
    http: web.http,
    blobs: {
      async put(key, body) {
        stored.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body);
      },
      async get(key) {
        return stored.get(key) ?? null;
      },
    },
    llm: options.llm === false ? null : llm.llm,
    packs,
    now: clock.now,
    wait: async (ms) => clock.advance(ms),
  };
  return { clock, web, gates, stored, llm, ports };
}

export type World = ReturnType<typeof makeWorld>;
