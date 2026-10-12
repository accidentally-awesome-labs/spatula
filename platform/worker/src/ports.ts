import { packs } from '@spatula/pack-products';
import { r2Blobs } from './blobs';
import { secret, spatulaUserAgent } from './config';
import { withDatabase } from './database';
import { createGatePort } from './gate-port';
import { createHttpFetcher } from './http';
import { createAnthropicLlm } from './llm-anthropic';
import type { RefreshPorts } from './refresh';

/** The refresh pipeline's ports, from the Worker's bindings and secrets. */
export function workerPorts(env: Env): RefreshPorts {
  const http = createHttpFetcher({ userAgent: spatulaUserAgent(env) });
  const apiKey = secret(env, 'ANTHROPIC_API_KEY');
  const gatewayUrl = secret(env, 'AI_GATEWAY_URL');
  return {
    withDb: (fn) => withDatabase(env, fn),
    gate: createGatePort({
      gateFor(host) {
        const stub = env.HOST_GATE.get(env.HOST_GATE.idFromName(host));
        return {
          robotsDue: (now) => stub.robotsDue(now),
          opensAt: () => stub.opensAt(),
          storeRobots: (record, now, minIntervalMs) => stub.storeRobots(record, now, minIntervalMs),
          reserve: (request) => stub.reserve(request),
          record: (response) => stub.record(response),
        };
      },
      http,
      now: () => Date.now(),
    }),
    http,
    blobs: r2Blobs(env.STORE),
    // Calls go through AI Gateway, which logs them and records their cost. A key without the
    // gateway's address would call Anthropic directly, unlogged, so it gets no LLM at all.
    llm:
      apiKey === undefined || gatewayUrl === undefined
        ? null
        : createAnthropicLlm({
            apiKey,
            model: env.LLM_MODEL,
            baseURL: gatewayUrl,
            gatewayToken: secret(env, 'AI_GATEWAY_TOKEN'),
          }),
    packs,
    now: () => new Date(),
    wait: (ms) => scheduler.wait(ms),
  };
}
