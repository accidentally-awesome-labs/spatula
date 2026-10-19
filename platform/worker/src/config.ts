import { userAgent } from './http';

/*
 * Secrets are set with `wrangler secret put`, or in .dev.vars locally, and every one is optional:
 * without OWNER_TOKEN_HASH the API answers 503, and runs skip the LLM unless both
 * ANTHROPIC_API_KEY and AI_GATEWAY_URL are set (AI_GATEWAY_TOKEN is optional).
 * WEB_BOT_AUTH_KEY, an Ed25519 private key as a JWK, makes the Worker sign its requests and serve
 * its key directory. Each consumer has two more, named after it (see consumerSecret). Secrets are
 * read by name rather than through Env, whose generated type depends on whether a .dev.vars file
 * happens to exist.
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

/**
 * A consumer's secret: CONSUMER_<NAME>_TOKEN_HASH, the SHA-256 of its token, or
 * CONSUMER_<NAME>_HMAC_KEY, which signs its acknowledgments. The name is the consumer's, in
 * capitals with underscores for hyphens: crowdio's are CONSUMER_CROWDIO_….
 */
export function consumerSecret(
  env: Env,
  consumer: string,
  kind: 'TOKEN_HASH' | 'HMAC_KEY',
): string | undefined {
  const name = `CONSUMER_${consumer.toUpperCase().replaceAll('-', '_')}_${kind}`;
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
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
