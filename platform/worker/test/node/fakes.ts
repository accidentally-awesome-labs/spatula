import {
  INITIAL_GATE_STATE,
  readTaxonomyAnswer,
  type Decider,
  type DecisionRequest,
  type GateState,
  type LlmPort,
  type TaxonomyDecider,
  type TaxonomyModelAnswer,
  type TaxonomyRequest,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import type { Executor } from '@spatula/store';
import { createGatePort, GateKeeper } from '../../src/gate-port';
import type { ModelSetup } from '../../src/models';
import type { HttpPort, RefreshPorts, StepRunner } from '../../src/refresh';
import { answerFor, decisionFor, taxonomyFor, type Reply, type SlugChances } from '../pages';

/** Time that moves only when told: by waits, sleeps, and each request's 100 ms. */
export class Clock {
  constructor(public ms: number) {}
  now = () => new Date(this.ms);
  advance = (ms: number) => {
    this.ms += ms;
  };
}

/** The steps a Workflow has finished, by name: each result as the JSON it was kept as. */
export type StepCache = Map<string, string | undefined>;

/** A finished step's result as the Workflow hands it back: a fresh copy, from its JSON. */
const revive = (kept: string | undefined) => (kept === undefined ? undefined : JSON.parse(kept));

/**
 * Runs steps at once, in order. Results go through JSON, as Workflows keep them. Runs that share a
 * cache are replays of one another, as Workflows replays an instance: a step with a result in the
 * cache returns it without running (`replayed` lists those), and a step that finishes adds its own.
 * A step that throws adds nothing, so a replay runs it again. `names` lists every step a run asks
 * for, cached or not.
 */
export function fakeStep(clock: Clock, cache?: StepCache) {
  const names: string[] = [];
  const replayed: string[] = [];
  const step: StepRunner = {
    async do(name, fn) {
      if (names.includes(name)) throw new Error(`Step ${name} ran twice`);
      names.push(name);
      if (cache?.has(name)) {
        replayed.push(name);
        return revive(cache.get(name));
      }
      const result = await fn();
      const kept = result === undefined ? undefined : JSON.stringify(result);
      cache?.set(name, kept);
      return revive(kept);
    },
    async sleep(name, ms) {
      names.push(name);
      if (cache?.has(name)) {
        replayed.push(name);
        return;
      }
      clock.advance(ms);
      cache?.set(name, undefined);
    },
  };
  return { step, names, replayed };
}

/** A small web: each address answers as its route says, or 404. Every request is logged. */
export function fakeWeb(clock: Clock) {
  const routes = new Map<string, Reply>();
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const http: HttpPort = {
    async get(url, headers, options = {}) {
      requests.push({ url, headers });
      clock.advance(100);
      const reply = routes.get(url) ?? { status: 404 };
      const ok = reply.status >= 200 && reply.status < 300;
      const full = ok
        ? (reply.bytes ?? new TextEncoder().encode(reply.body ?? ''))
        : new Uint8Array();
      const max = options.maxBytes ?? Number.POSITIVE_INFINITY;
      return {
        ok: true,
        status: reply.status,
        headers: { 'content-type': 'text/html; charset=utf-8', ...reply.headers },
        body: full.subarray(0, max),
        truncated: reply.truncated === true || full.byteLength > max,
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

/** A decider that answers from a table, and keeps each question it's asked. */
export function fakeDecider(answer: (request: DecisionRequest) => Record<string, number> | null) {
  const calls: DecisionRequest[] = [];
  const decider: Decider = {
    name: 'llm:test-model',
    async decide(request) {
      calls.push(request);
      const probabilities = answer(request) ?? {};
      const [best] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
      return {
        answer: best?.[0] ?? null,
        probabilities,
        evidence: 'the test’s reason',
        usage: { inputTokens: 500, outputTokens: 20 },
      };
    },
  };
  return { decider, calls };
}

/**
 * A taxonomy decider that answers by slug from a table, read as the real one reads a model's answer:
 * only the options it was asked about count. It keeps each request.
 */
export function fakeTaxonomyDecider(answer: (request: TaxonomyRequest) => SlugChances | null) {
  const calls: TaxonomyRequest[] = [];
  const decider: TaxonomyDecider = {
    name: 'llm:test-model',
    async decide(request) {
      calls.push(request);
      const chances = answer(request) ?? {};
      const output: TaxonomyModelAnswer = {
        shelves: Object.entries(chances.shelves ?? {}).map(([shelf, probability]) => ({
          shelf,
          probability,
        })),
        functions: Object.entries(chances.functions ?? {}).map(([fn, probability]) => ({
          function: fn,
          probability,
        })),
        values: Object.entries(chances.values ?? {}).map(([value, probability]) => ({
          value,
          probability,
        })),
        reason: 'the test’s reason',
      };
      return {
        probabilities: readTaxonomyAnswer(request.taxonomy, request.parts, output),
        evidence: 'the test’s reason',
        usage: { inputTokens: 600, outputTokens: 40 },
      };
    },
  };
  return { decider, calls };
}

/** The tests' models: every model can be asked, at $1 per million tokens each way. */
export function testModelSetup(overrides: Partial<ModelSetup> = {}): ModelSetup {
  return {
    defaultModel: 'test/model',
    problem: () => null,
    price: () => ({ input: 1, output: 1 }),
    ...overrides,
  };
}

/** Everything a refresh touches, faked, around a real database. State lasts across runs. */
export function makeWorld(
  db: Executor,
  routes: Record<string, Reply>,
  options: { llm?: boolean; decider?: boolean; taxonomyDecider?: boolean } = {},
) {
  const clock = new Clock(Date.UTC(2026, 9, 10));
  const web = fakeWeb(clock);
  for (const [url, reply] of Object.entries(routes)) web.routes.set(url, reply);
  const gates = memoryGates();
  const stored = new Map<string, Uint8Array>();
  const llm = fakeLlm(answerFor);
  const decider = fakeDecider(decisionFor);
  const taxonomyDecider = fakeTaxonomyDecider(taxonomyFor);
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
      async delete(keys) {
        for (const key of keys) stored.delete(key);
      },
    },
    llm: options.llm === false ? null : llm.llm,
    decider: options.decider === false ? null : decider.decider,
    taxonomyDecider: options.taxonomyDecider === false ? null : taxonomyDecider.decider,
    models: testModelSetup(),
    packs,
    now: clock.now,
    wait: async (ms) => clock.advance(ms),
  };
  return { clock, web, gates, stored, llm, decider, taxonomyDecider, ports };
}

export type World = ReturnType<typeof makeWorld>;
