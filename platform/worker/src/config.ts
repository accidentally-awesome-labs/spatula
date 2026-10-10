import { userAgent } from './http';

/*
 * Secrets are set with `wrangler secret put`, or in .dev.vars locally, and every one is optional:
 * without OWNER_TOKEN_HASH the API answers 503, and without ANTHROPIC_API_KEY runs skip the LLM.
 * They're read by name rather than through Env, whose generated type depends on whether a
 * .dev.vars file happens to exist.
 */

export type SecretName =
  | 'OWNER_TOKEN_HASH'
  | 'ANTHROPIC_API_KEY'
  | 'AI_GATEWAY_URL'
  | 'AI_GATEWAY_TOKEN';

export function secret(env: Env, name: SecretName): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function spatulaUserAgent(env: Env): string {
  return userAgent(env.SPATULA_VERSION, env.PUBLIC_URL);
}
