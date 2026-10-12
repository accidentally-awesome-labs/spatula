import { userAgent } from './http';

/*
 * Secrets are set with `wrangler secret put`, or in .dev.vars locally, and every one is optional:
 * without OWNER_TOKEN_HASH the API answers 503, and runs skip the LLM unless both
 * ANTHROPIC_API_KEY and AI_GATEWAY_URL are set (AI_GATEWAY_TOKEN is optional).
 * WEB_BOT_AUTH_KEY, an Ed25519 private key as a JWK, makes the Worker sign its requests and serve
 * its key directory. Secrets are read by name rather than through Env, whose generated type
 * depends on whether a .dev.vars file happens to exist.
 */

export type SecretName =
  | 'OWNER_TOKEN_HASH'
  | 'ANTHROPIC_API_KEY'
  | 'AI_GATEWAY_URL'
  | 'AI_GATEWAY_TOKEN'
  | 'WEB_BOT_AUTH_KEY';

export function secret(env: Env, name: SecretName): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function spatulaUserAgent(env: Env): string {
  return userAgent(env.SPATULA_VERSION, env.PUBLIC_URL);
}
