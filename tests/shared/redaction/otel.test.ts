/**
 * Sink test: OTel (RedactionSpanProcessor)
 * Verifies that canary secrets in span attributes are redacted before export.
 */
import { describe, it, expect } from 'vitest';
import { RedactionSpanProcessor } from '@accidentally-awesome-labs/spatula-shared';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { HrTime, SpanContext, SpanStatus } from '@opentelemetry/api';

const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummysignatureXXXXXXXX';
const CANARY_SK = 'sk-test1234567890abcdef1234';
const CANARY_BEARER = 'Bearer abcdefghij1234567890XYZ';
const CANARY_STRIPE = 'sk_live_abcdefghij1234567890';

const ALL_CANARIES = [CANARY_JWT, CANARY_SK, CANARY_BEARER, CANARY_STRIPE];

/** Minimal fake ReadableSpan with mutable attributes for testing */
function makeFakeSpan(attributes: Record<string, unknown>): ReadableSpan {
  const fakeSpanContext: SpanContext = {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    traceFlags: 1,
  };
  const fakeHrTime: HrTime = [0, 0];
  const fakeStatus: SpanStatus = { code: 0 };

  return {
    name: 'test-span',
    kind: 0,
    spanContext: () => fakeSpanContext,
    parentSpanId: undefined,
    startTime: fakeHrTime,
    endTime: fakeHrTime,
    status: fakeStatus,
    attributes,
    links: [],
    events: [],
    duration: fakeHrTime,
    ended: true,
    resource: {} as any,
    instrumentationLibrary: { name: 'test' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

describe('OTel sink — RedactionSpanProcessor.onEnd scrubs all canaries', () => {
  it('redacts sk- key from span attributes', () => {
    const attrs = { apiKey: CANARY_SK, safe: 'hello' };
    const span = makeFakeSpan(attrs);
    new RedactionSpanProcessor().onEnd(span);
    expect(attrs.apiKey).toBe('[REDACTED]');
    expect(attrs.safe).toBe('hello');
  });

  it('redacts JWT from span attribute', () => {
    const attrs = { token: CANARY_JWT };
    const span = makeFakeSpan(attrs);
    new RedactionSpanProcessor().onEnd(span);
    expect(attrs.token).toBe('[REDACTED]');
  });

  it('redacts Bearer token from span attribute', () => {
    const attrs = { authorization: CANARY_BEARER };
    const span = makeFakeSpan(attrs);
    new RedactionSpanProcessor().onEnd(span);
    expect(attrs.authorization).toBe('[REDACTED]');
  });

  it('redacts Stripe live key from span attribute', () => {
    const attrs = { stripeKey: CANARY_STRIPE };
    const span = makeFakeSpan(attrs);
    new RedactionSpanProcessor().onEnd(span);
    expect(attrs.stripeKey).toBe('[REDACTED]');
  });

  it('none of the canary raw strings remain in attributes after onEnd', () => {
    const attrs: Record<string, unknown> = {};
    for (let i = 0; i < ALL_CANARIES.length; i++) {
      attrs[`secret${i}`] = ALL_CANARIES[i];
    }
    const span = makeFakeSpan(attrs);
    new RedactionSpanProcessor().onEnd(span);
    const serialized = JSON.stringify(attrs);
    for (const canary of ALL_CANARIES) {
      const tokenBody = canary.startsWith('Bearer ') ? canary.slice(7) : canary;
      expect(serialized).not.toContain(tokenBody);
    }
  });

  it('leaves numeric and boolean attributes unchanged', () => {
    const attrs = { count: 42, ok: true, message: 'clean' };
    const span = makeFakeSpan(attrs);
    new RedactionSpanProcessor().onEnd(span);
    expect(attrs.count).toBe(42);
    expect(attrs.ok).toBe(true);
    expect(attrs.message).toBe('clean');
  });

  it('forceFlush returns a resolved promise', async () => {
    await expect(new RedactionSpanProcessor().forceFlush()).resolves.toBeUndefined();
  });

  it('shutdown returns a resolved promise', async () => {
    await expect(new RedactionSpanProcessor().shutdown()).resolves.toBeUndefined();
  });
});
