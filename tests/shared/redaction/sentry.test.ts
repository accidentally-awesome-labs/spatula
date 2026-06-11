/**
 * Sink test: Sentry (redactSentryEvent)
 * Verifies that none of the canary secrets appear in the processed Sentry event.
 */
import { describe, it, expect } from 'vitest';
import { redactSentryEvent } from '@spatula/shared';

const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummysignatureXXXXXXXX';
const CANARY_SK = 'sk-test1234567890abcdef1234';
const CANARY_BEARER = 'Bearer abcdefghij1234567890XYZ';
const CANARY_STRIPE = 'sk_live_abcdefghij1234567890';

const ALL_CANARIES = [CANARY_JWT, CANARY_SK, CANARY_BEARER, CANARY_STRIPE];

/** Build a fake Sentry ErrorEvent-shaped object */
function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'error',
    exception: {
      values: [
        {
          type: 'Error',
          value: 'Something went wrong with token: ' + CANARY_JWT,
        },
        {
          type: 'TypeError',
          value: 'Invalid key: ' + CANARY_SK,
        },
      ],
    },
    message: 'Auth failed for ' + CANARY_BEARER,
    extra: {
      apiKey: CANARY_SK,
      nested: { stripeKey: CANARY_STRIPE },
    },
    contexts: {
      request: {
        headers: {
          authorization: CANARY_BEARER,
        },
      },
    },
    ...overrides,
  };
}

describe('Sentry sink — redactSentryEvent scrubs all canaries', () => {
  it('scrubs canary from exception.values[].value', () => {
    const event = makeEvent();
    const result = redactSentryEvent(event);
    const exception = result.exception as { values: Array<{ value: string }> };
    for (const ex of exception.values) {
      expect(ex.value).not.toContain(CANARY_JWT);
      expect(ex.value).not.toContain(CANARY_SK);
    }
    expect(exception.values[0].value).toContain('[REDACTED]');
  });

  it('scrubs canary from event.message', () => {
    const event = makeEvent();
    const result = redactSentryEvent(event);
    expect(result.message).not.toContain('abcdefghij1234567890XYZ');
    expect(result.message as string).toContain('[REDACTED]');
  });

  it('scrubs canary from event.extra', () => {
    const event = makeEvent();
    const result = redactSentryEvent(event);
    const extra = result.extra as Record<string, unknown>;
    expect(extra.apiKey).toBe('[REDACTED]');
    expect((extra.nested as Record<string, unknown>).stripeKey).toBe('[REDACTED]');
  });

  it('scrubs canary from event.contexts', () => {
    const event = makeEvent();
    const result = redactSentryEvent(event);
    const contexts = result.contexts as Record<string, unknown>;
    const headers = (contexts.request as Record<string, unknown>).headers as Record<
      string,
      unknown
    >;
    expect(headers.authorization).not.toContain('abcdefghij1234567890XYZ');
  });

  it('none of the canary raw strings appear in the processed event (JSON stringify check)', () => {
    const event = makeEvent({
      extra: Object.fromEntries(ALL_CANARIES.map((c, i) => [`secret${i}`, c])),
    });
    const result = redactSentryEvent(event);
    const serialized = JSON.stringify(result);
    for (const canary of ALL_CANARIES) {
      const tokenBody = canary.startsWith('Bearer ') ? canary.slice(7) : canary;
      expect(serialized).not.toContain(tokenBody);
    }
  });

  it('handles event with no exception gracefully', () => {
    const event: Record<string, unknown> = {
      type: 'error',
      message: 'plain error with ' + CANARY_SK,
    };
    expect(() => redactSentryEvent(event)).not.toThrow();
    expect(event.message).not.toContain(CANARY_SK);
  });
});
