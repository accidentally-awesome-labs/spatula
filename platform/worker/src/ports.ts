import { importSigningKey, randomNonce, signRequest, type SigningKey } from '@spatula/core';
import { packs } from '@spatula/pack-products';
import { r2Blobs } from './blobs';
import { secret, spatulaUserAgent } from './config';
import { withDatabase } from './database';
import { createGatePort } from './gate-port';
import { createHttpFetcher } from './http';
import { workerModels } from './models';
import type { RefreshPorts } from './refresh';

/** The refresh pipeline's ports, from the Worker's bindings and secrets. */
export function workerPorts(env: Env): RefreshPorts {
  const http = createHttpFetcher({ userAgent: spatulaUserAgent(env), sign: signer(env) });
  // Every call goes through AI Gateway, which logs it and records its cost (ADR 0010). Without the
  // gateway's address the Worker asks no model.
  const models = workerModels(env);
  const fallback = models.ports === null ? null : models.ports(models.setup.defaultModel);
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
    llm: fallback?.llm ?? null,
    decider: fallback?.decider ?? null,
    taxonomyDecider: fallback?.taxonomyDecider ?? null,
    models: models.setup,
    ...(models.ports === null ? {} : { modelPorts: models.ports }),
    packs,
    now: () => new Date(),
    wait: (ms) => scheduler.wait(ms),
  };
}

/** Signs each request with WEB_BOT_AUTH_KEY, if it's set. The key is read once per instance. */
function signer(env: Env): ((url: string) => Promise<Record<string, string>>) | undefined {
  const jwk = secret(env, 'WEB_BOT_AUTH_KEY');
  if (jwk === undefined) return undefined;
  let key: Promise<SigningKey> | null = null;
  return async (url) => {
    key ??= importSigningKey(jwk);
    return signRequest({
      url,
      agent: new URL(env.PUBLIC_URL).origin,
      key: await key,
      now: Date.now(),
      nonce: randomNonce(),
    });
  };
}
