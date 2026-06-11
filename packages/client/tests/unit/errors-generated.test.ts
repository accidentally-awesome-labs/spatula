import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@spatula/shared';
import {
  ERROR_CLASS_BY_CODE,
  decodeError,
  JobNotFoundError,
  RateLimitExceededError,
} from '../../src/errors/generated.js';
import { SpatulaApiError } from '../../src/errors/base.js';

describe('Generated error classes (codegen output)', () => {
  it('has one class for every ErrorCode value', () => {
    const codeValues = Object.values(ErrorCode);
    for (const code of codeValues) {
      expect(ERROR_CLASS_BY_CODE).toHaveProperty(code);
    }
  });

  it('every entry in ERROR_CLASS_BY_CODE is a SpatulaApiError subclass', () => {
    for (const [code, Ctor] of Object.entries(ERROR_CLASS_BY_CODE)) {
      // Cannot instanceof a class itself — assert via prototype chain.
      const proto = Ctor.prototype;
      expect(proto, `class for ${code} must extend SpatulaApiError`).toBeInstanceOf(
        SpatulaApiError,
      );
    }
  });

  it('decodeError returns the matching subclass for a known code', () => {
    const err = decodeError(
      {
        code: 'JOB.NOT_FOUND',
        message: 'Job not found',
        requestId: 'r1',
      },
      404,
    );
    expect(err).toBeInstanceOf(JobNotFoundError);
    expect(err.code).toBe('JOB.NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.requestId).toBe('r1');
  });

  it('decodeError falls back to SpatulaApiError for unknown codes', () => {
    const err = decodeError({ code: 'UNKNOWN.UNKNOWN', message: 'huh', requestId: 'r2' }, 500);
    expect(err).toBeInstanceOf(SpatulaApiError);
    expect(err.constructor.name).toBe('SpatulaApiError');
    expect(err.code).toBe('UNKNOWN.UNKNOWN');
  });

  it('RateLimitExceededError carries details through the envelope', () => {
    const err = decodeError(
      {
        code: 'RATE_LIMIT.EXCEEDED',
        message: 'too many requests',
        requestId: 'r3',
        details: { limit: 100, resetAt: 1234567890 },
      },
      429,
    );
    expect(err).toBeInstanceOf(RateLimitExceededError);
    expect(err.details).toEqual({ limit: 100, resetAt: 1234567890 });
  });

  it('ERROR_CLASS_BY_CODE has at least 20 entries', () => {
    expect(Object.keys(ERROR_CLASS_BY_CODE).length).toBeGreaterThanOrEqual(20);
  });
});
