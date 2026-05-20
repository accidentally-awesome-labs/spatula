/**
 * Sink test: stdout (pino logger writing to an in-memory stream)
 * Verifies that none of the canary secrets appear in captured stdout output.
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACT_PATHS, REDACTED_PLACEHOLDER, redactValue, redactObject } from '@spatula/shared';

// Fixed canary secrets used across all per-sink tests
const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummysignatureXXXXXXXX';
const CANARY_SK = 'sk-test1234567890abcdef1234';
const CANARY_BEARER = 'Bearer abcdefghij1234567890XYZ';
const CANARY_STRIPE = 'sk_live_abcdefghij1234567890';

const ALL_CANARIES = [CANARY_JWT, CANARY_SK, CANARY_BEARER, CANARY_STRIPE];

/**
 * Build a pino logger using the same options as createLogger but writing to
 * a Writable buffer so we can capture output without touching stdout.
 */
function buildTestLogger(): { logger: pino.Logger; getOutput: () => string } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });

  const logger = pino(
    {
      level: 'debug',
      redact: { paths: REDACT_PATHS, censor: REDACTED_PLACEHOLDER },
      serializers: {
        err: (err: Error) => {
          const s = pino.stdSerializers.err(err);
          if (s.message) s.message = redactValue(s.message);
          return s;
        },
      },
      formatters: {
        log: (obj) => redactObject(obj),
      },
    },
    dest,
  );

  return {
    logger,
    getOutput: () => chunks.join(''),
  };
}

describe('stdout sink — no raw canary secrets in output', () => {
  it('redacts sk- key logged at a top-level field', async () => {
    const { logger, getOutput } = buildTestLogger();
    logger.info({ apiKey: CANARY_SK }, 'test message');
    await new Promise((r) => setImmediate(r));
    const output = getOutput();
    expect(output).not.toContain(CANARY_SK);
    expect(output).toContain('[REDACTED]');
  });

  it('redacts JWT logged inside a nested object', async () => {
    const { logger, getOutput } = buildTestLogger();
    logger.info({ auth: { token: CANARY_JWT } }, 'auth event');
    await new Promise((r) => setImmediate(r));
    const output = getOutput();
    expect(output).not.toContain(CANARY_JWT);
  });

  it('redacts Bearer token in a string field', async () => {
    const { logger, getOutput } = buildTestLogger();
    logger.info({ authorization: CANARY_BEARER }, 'bearer event');
    await new Promise((r) => setImmediate(r));
    const output = getOutput();
    expect(output).not.toContain('abcdefghij1234567890XYZ');
  });

  it('redacts Stripe live key in a string field', async () => {
    const { logger, getOutput } = buildTestLogger();
    logger.info({ stripeKey: CANARY_STRIPE }, 'stripe event');
    await new Promise((r) => setImmediate(r));
    const output = getOutput();
    expect(output).not.toContain(CANARY_STRIPE);
  });

  it('none of the canary strings appear in any logged output', async () => {
    const { logger, getOutput } = buildTestLogger();
    for (const canary of ALL_CANARIES) {
      logger.info({ secret: canary }, `logged ${canary.slice(0, 8)}`);
    }
    await new Promise((r) => setImmediate(r));
    const output = getOutput();
    for (const canary of ALL_CANARIES) {
      // Bearer pattern: redact replaces the whole match; check the token body
      const tokenBody = canary.startsWith('Bearer ') ? canary.slice(7) : canary;
      expect(output).not.toContain(tokenBody);
    }
  });

  it('req.headers.authorization path is redacted', async () => {
    const { logger, getOutput } = buildTestLogger();
    logger.info({ req: { headers: { authorization: CANARY_BEARER } } }, 'request');
    await new Promise((r) => setImmediate(r));
    const output = getOutput();
    // fast-redact covers this known structural path
    expect(output).not.toContain('abcdefghij1234567890XYZ');
  });
});
