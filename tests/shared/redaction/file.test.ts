/**
 * Sink test: file (pino logger writing to a temp file)
 * Verifies that none of the canary secrets appear in the written file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createWriteStream, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { REDACT_PATHS, REDACTED_PLACEHOLDER, redactValue, redactObject } from '@spatula/shared';

const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummysignatureXXXXXXXX';
const CANARY_SK = 'sk-test1234567890abcdef1234';
const CANARY_BEARER = 'Bearer abcdefghij1234567890XYZ';
const CANARY_STRIPE = 'sk_live_abcdefghij1234567890';

const ALL_CANARIES = [CANARY_JWT, CANARY_SK, CANARY_BEARER, CANARY_STRIPE];

let tempFiles: string[] = [];

afterEach(() => {
  for (const f of tempFiles) {
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        // best-effort cleanup
      }
    }
  }
  tempFiles = [];
});

function buildFileLogger(): { logger: pino.Logger; filePath: string; flush: () => Promise<void> } {
  const filePath = join(
    tmpdir(),
    `spatula-redact-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  );
  tempFiles.push(filePath);

  const dest = pino.destination({ dest: filePath, sync: true });

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
    filePath,
    flush: () =>
      new Promise((resolve) => {
        dest.flushSync();
        resolve();
      }),
  };
}

describe('file sink — no raw canary secrets in written file', () => {
  it('redacts sk- key logged to file', async () => {
    const { logger, filePath, flush } = buildFileLogger();
    logger.info({ apiKey: CANARY_SK }, 'key event');
    await flush();
    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toContain(CANARY_SK);
    expect(content).toContain('[REDACTED]');
  });

  it('redacts JWT logged to file', async () => {
    const { logger, filePath, flush } = buildFileLogger();
    logger.info({ token: CANARY_JWT }, 'jwt event');
    await flush();
    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toContain(CANARY_JWT);
  });

  it('redacts Bearer token logged to file', async () => {
    const { logger, filePath, flush } = buildFileLogger();
    logger.info({ auth: CANARY_BEARER }, 'bearer event');
    await flush();
    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toContain('abcdefghij1234567890XYZ');
  });

  it('none of the canary strings appear in the file after logging all of them', async () => {
    const { logger, filePath, flush } = buildFileLogger();
    for (const canary of ALL_CANARIES) {
      logger.info({ secret: canary }, 'bulk log');
    }
    await flush();
    const content = readFileSync(filePath, 'utf8');
    for (const canary of ALL_CANARIES) {
      const tokenBody = canary.startsWith('Bearer ') ? canary.slice(7) : canary;
      expect(content).not.toContain(tokenBody);
    }
  });

  it('temp log file is cleaned up after test (cleanup verification)', async () => {
    const { logger, filePath, flush } = buildFileLogger();
    logger.info({ msg: 'clean' }, 'cleanup test');
    await flush();
    // File should exist before cleanup
    expect(existsSync(filePath)).toBe(true);
    // afterEach will clean it up — this just verifies the file was created
  });
});
