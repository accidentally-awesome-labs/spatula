import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Span, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Regex patterns that match secret-shaped substrings.
 * Each pattern uses the global flag so `replace` replaces ALL occurrences.
 * Patterns are re-evaluated per call because RegExp with /g flag is stateful —
 * we reset lastIndex by constructing fresh regexes each time via the factory approach,
 * or we use String.prototype.replace with /g (auto-resets lastIndex for replace).
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9]{20,}\b/g, // OpenRouter / OpenAI keys
  /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/gi, // Bearer tokens
  /\bey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, // JWTs
  /\bsk_live_[a-zA-Z0-9]{20,}\b/g, // Stripe live keys
  /\bsk_test_[a-zA-Z0-9]{20,}\b/g, // Stripe test keys
  /\bor-[a-zA-Z0-9]{20,}\b/g, // OpenRouter alternate prefix
];

/**
 * Replace every secret-shaped substring in a string with REDACTED_PLACEHOLDER.
 * Returns the original string unchanged if no patterns match.
 */
export function redactValue(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex before each use (global flag stateful if reused)
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}

/**
 * Deep-clone an object/array and apply redactValue to every string leaf.
 * Never mutates the input — always returns a fresh structure.
 * Handles null/undefined leaves and circular-reference-free graphs.
 */
export function redactObject<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }
  if (typeof input === 'string') {
    return redactValue(input) as unknown as T;
  }
  if (typeof input !== 'object') {
    // numbers, booleans, symbols, etc. — pass through
    return input;
  }
  if (Array.isArray(input)) {
    return (input as unknown[]).map((item) => redactObject(item)) as unknown as T;
  }
  // Plain object
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    result[key] = redactObject(value);
  }
  return result as unknown as T;
}

/**
 * Pino fast-redact path list — covers known structured field locations for
 * Authorization/Cookie headers and common secret-bearing keys.
 *
 * NOTE: fast-redact paths do NOT recurse into arbitrary depths. Use the
 * redactObject serializer backstop for unknown nesting (D-11 / Pitfall 1).
 */
export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.secret',
  '*.password',
  '*.apiKey',
  '*.api_key',
];

// ---------------------------------------------------------------------------
// Sentry hook
// ---------------------------------------------------------------------------

/**
 * Scrub a Sentry ErrorEvent in-place before it is sent.
 * Mutates and returns the event (Sentry's beforeSend contract accepts mutation).
 */
export function redactSentryEvent(event: Record<string, unknown>): Record<string, unknown> {
  // Scrub exception values
  const exception = event.exception as
    | { values?: Array<{ value?: string }> }
    | undefined;
  if (exception?.values) {
    for (const ex of exception.values) {
      if (typeof ex.value === 'string') {
        ex.value = redactValue(ex.value);
      }
    }
  }

  // Scrub message field
  if (typeof event.message === 'string') {
    event.message = redactValue(event.message);
  }

  // Scrub extra context
  if (event.extra !== null && event.extra !== undefined) {
    event.extra = redactObject(event.extra as Record<string, unknown>);
  }

  // Scrub contexts
  if (event.contexts !== null && event.contexts !== undefined) {
    event.contexts = redactObject(event.contexts as Record<string, unknown>);
  }

  return event;
}

// ---------------------------------------------------------------------------
// OTel SpanProcessor
// ---------------------------------------------------------------------------

/**
 * OTel SpanProcessor that scrubs span attributes before they are exported.
 * Register BEFORE BatchSpanProcessor so spans are redacted prior to export.
 * Attribute mutation in onEnd is the established community pattern (Pitfall 2).
 */
export class RedactionSpanProcessor implements SpanProcessor {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onStart(_span: Span, _parentContext: Context): void {
    // no-op — attributes may not be fully populated at start time
  }

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      if (typeof attrs[key] === 'string') {
        attrs[key] = redactValue(attrs[key] as string);
      }
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
