import { userAgent } from './http';

/*
 * Secrets are set with `wrangler secret put`, or in .dev.vars locally, and every one is optional:
 * without OWNER_TOKEN_HASH the API answers 503, and runs skip the LLM unless AI_GATEWAY_URL is set;
 * each provider's key is ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, CEREBRAS_API_KEY,
 * or GROQ_API_KEY, or the gateway holds it (LLM_GATEWAY_KEYS, which needs AI_GATEWAY_TOKEN). ADR 0010.
 * WEB_BOT_AUTH_KEY, an Ed25519 private key as a JWK, makes the Worker sign its requests and serve
 * its key directory. ACCESS_TEAM_DOMAIN, ACCESS_AUD, and OWNER_EMAIL open the console's API,
 * behind Cloudflare Access (ADR 0009). Each consumer has up to three more, named after it (see
 * consumerSecret). Secrets are read by name rather than through Env, whose generated type depends
 * on whether a .dev.vars file happens to exist.
 */

export type SecretName =
  | 'OWNER_TOKEN_HASH'
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'CEREBRAS_API_KEY'
  | 'GROQ_API_KEY'
  | 'AI_GATEWAY_URL'
  | 'AI_GATEWAY_TOKEN'
  | 'WEB_BOT_AUTH_KEY'
  | 'ACCESS_TEAM_DOMAIN'
  | 'ACCESS_AUD'
  | 'OWNER_EMAIL';

export function secret(env: Env, name: SecretName): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A consumer's secret: CONSUMER_<NAME>_TOKEN_HASH, the SHA-256 of its token;
 * CONSUMER_<NAME>_HMAC_KEY, which signs its acknowledgments; or CONSUMER_<NAME>_SCOPES, what its
 * reviewers may do (see consumerScopes). The name is the consumer's, in capitals with underscores
 * for hyphens: crowdio's are CONSUMER_CROWDIO_….
 */
export function consumerSecret(
  env: Env,
  consumer: string,
  kind: 'TOKEN_HASH' | 'HMAC_KEY' | 'SCOPES',
): string | undefined {
  const name = `CONSUMER_${consumer.toUpperCase().replaceAll('-', '_')}_${kind}`;
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * What a consumer's reviewers may do through the review API (ADR 0009): answer questions, and
 * approve the proposals that only add to a taxonomy. The owner may do everything.
 */
export const SCOPES = ['review:answer', 'taxonomy:approve-additive'] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * The scopes the owner granted a consumer, comma-separated in CONSUMER_<NAME>_SCOPES. One Spatula
 * doesn't know is ignored, so a typo grants nothing.
 */
export function consumerScopes(env: Env, consumer: string): Scope[] {
  const granted = new Set(
    (consumerSecret(env, consumer, 'SCOPES') ?? '').split(',').map((scope) => scope.trim()),
  );
  return SCOPES.filter((scope) => granted.has(scope));
}

export function spatulaUserAgent(env: Env): string {
  return userAgent(env.SPATULA_VERSION, env.PUBLIC_URL);
}

/**
 * Whether Cloudflare lists Spatula as a verified bot (ADR 0006): the VERIFIED_BOT variable says
 * "true". It's read by name, as secrets are, because the generated Env types a variable as the
 * very value wrangler.jsonc holds, which a comparison with "true" wouldn't pass the type check.
 */
export function verifiedBot(env: Env): boolean {
  return (env as unknown as Record<string, unknown>).VERIFIED_BOT === 'true';
}
