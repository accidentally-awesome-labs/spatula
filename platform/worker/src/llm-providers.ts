/*
 * The providers Spatula asks models of, all through the `spatula-llm` AI Gateway (ADR 0010). Each
 * speaks Anthropic's Messages format or OpenAI's Chat Completions format, has a route under the
 * gateway's base address, and a Worker secret for its key. A provider whose key the gateway holds
 * needs no secret: LLM_GATEWAY_KEYS names it. Adding a provider is an entry here and a test.
 */

export type ProviderFormat = 'anthropic' | 'openai';

export type ProviderSecret =
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'CEREBRAS_API_KEY'
  | 'GROQ_API_KEY';

export interface Provider {
  format: ProviderFormat;
  /**
   * Its route under the gateway's base address: the Messages API's base for Anthropic's format
   * (the SDK adds /v1/messages), and the chat completions address for OpenAI's.
   */
  route: string;
  /** The Worker secret that holds its key. */
  secret: ProviderSecret;
  /** The field that caps an answer's tokens, in OpenAI's format: providers differ. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Fields every request to it carries, in OpenAI's format. */
  extra?: Record<string, unknown>;
}

export const PROVIDERS: Readonly<Record<string, Provider>> = {
  anthropic: { format: 'anthropic', route: '/anthropic', secret: 'ANTHROPIC_API_KEY' },
  openai: {
    format: 'openai',
    route: '/openai/chat/completions',
    secret: 'OPENAI_API_KEY',
    maxTokensField: 'max_completion_tokens',
  },
  openrouter: {
    format: 'openai',
    route: '/openrouter/v1/chat/completions',
    secret: 'OPENROUTER_API_KEY',
    maxTokensField: 'max_tokens',
    // No host may keep or train on what it's sent, and only hosts that honour the JSON schema are
    // used (ADR 0010).
    extra: { provider: { data_collection: 'deny', require_parameters: true } },
  },
  cerebras: {
    format: 'openai',
    route: '/cerebras/chat/completions',
    secret: 'CEREBRAS_API_KEY',
    maxTokensField: 'max_completion_tokens',
  },
  groq: {
    format: 'openai',
    route: '/groq/chat/completions',
    secret: 'GROQ_API_KEY',
    maxTokensField: 'max_completion_tokens',
  },
};

export function providerNamed(name: string): Provider | null {
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name]! : null;
}

/**
 * The gateway's base address, from AI_GATEWAY_URL. Before ADR 0010 that was the gateway's
 * Anthropic address, so a trailing /anthropic is dropped, and the secret keeps its value.
 */
export function gatewayBase(url: string): string {
  let base = url.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base.endsWith('/anthropic') ? base.slice(0, -'/anthropic'.length) : base;
}

/** A message with any of these secrets replaced, so no key reaches a note or the fetch log. */
export function redact(message: string, secrets: readonly (string | undefined)[]): string {
  return secrets.reduce<string>(
    (text, secret) =>
      secret === undefined || secret === '' ? text : text.replaceAll(secret, '[key]'),
    message,
  );
}
