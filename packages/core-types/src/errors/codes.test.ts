import { describe, it, expect } from 'vitest';
import { ErrorCode, STATUS_MAP } from './codes.js';

describe('ErrorCode enum (frozen v1 shape)', () => {
  it('every code matches DOMAIN.CODE shape (^[A-Z_]+\\.[A-Z_]+$)', () => {
    const pattern = /^[A-Z_]+\.[A-Z_]+$/;
    const values = Object.values(ErrorCode);
    expect(values.length).toBeGreaterThanOrEqual(20);
    for (const value of values) {
      expect(value, `code "${value}" must match DOMAIN.CODE`).toMatch(pattern);
    }
  });

  it('every code value is unique', () => {
    const values = Object.values(ErrorCode);
    const set = new Set(values);
    expect(set.size).toBe(values.length);
  });

  it('exposes at least one code in each documented category', () => {
    const values = new Set(Object.values(ErrorCode));
    const requiredDomains = [
      'JOB',
      'EXTRACTION',
      'SCHEMA',
      'ENTITY',
      'EXPORT',
      'AUTH',
      'TENANT',
      'RATE_LIMIT',
      'QUOTA',
      'VERSION',
      'VALIDATION',
      'IDEMPOTENCY',
      'WEBHOOK',
      'INTERNAL',
    ];
    for (const domain of requiredDomains) {
      const found = [...values].some((v) => v.startsWith(`${domain}.`));
      expect(found, `expected at least one code in domain "${domain}"`).toBe(true);
    }
  });
});

describe('STATUS_MAP (HTTP status mapping)', () => {
  it('has an entry for every ErrorCode value (no orphans)', () => {
    const codeValues = Object.values(ErrorCode);
    const mapKeys = Object.keys(STATUS_MAP);
    expect(mapKeys.length).toBe(codeValues.length);
    for (const code of codeValues) {
      expect(STATUS_MAP).toHaveProperty(code);
    }
  });

  it('every mapped status is in the allowed set', () => {
    const allowed = new Set([400, 401, 403, 404, 409, 422, 426, 429, 500, 502, 503, 504]);
    for (const [code, status] of Object.entries(STATUS_MAP)) {
      expect(allowed.has(status), `code "${code}" has unexpected status ${status}`).toBe(true);
    }
  });

  it('maps *.NOT_FOUND codes to 404', () => {
    for (const [code, status] of Object.entries(STATUS_MAP)) {
      if (code.endsWith('.NOT_FOUND')) {
        expect(status).toBe(404);
      }
    }
  });

  it('maps AUTH.MISSING_TOKEN and AUTH.INVALID_TOKEN to 401', () => {
    expect(STATUS_MAP[ErrorCode.AUTH_MISSING_TOKEN]).toBe(401);
    expect(STATUS_MAP[ErrorCode.AUTH_INVALID_TOKEN]).toBe(401);
  });

  it('maps AUTH.INSUFFICIENT_SCOPE to 403', () => {
    expect(STATUS_MAP[ErrorCode.AUTH_INSUFFICIENT_SCOPE]).toBe(403);
  });

  it('maps RATE_LIMIT.EXCEEDED and QUOTA.EXCEEDED to 429', () => {
    expect(STATUS_MAP[ErrorCode.RATE_LIMIT_EXCEEDED]).toBe(429);
    expect(STATUS_MAP[ErrorCode.QUOTA_EXCEEDED]).toBe(429);
  });

  it('maps VERSION.MISMATCH to 426 (Upgrade Required, RFC 7231)', () => {
    expect(STATUS_MAP[ErrorCode.VERSION_MISMATCH]).toBe(426);
  });

  it('maps INTERNAL.* infrastructure codes to 5xx', () => {
    expect(STATUS_MAP[ErrorCode.INTERNAL_ERROR]).toBe(500);
    expect(STATUS_MAP[ErrorCode.INTERNAL_NETWORK]).toBe(502);
    expect(STATUS_MAP[ErrorCode.INTERNAL_QUEUE]).toBe(503);
    expect(STATUS_MAP[ErrorCode.INTERNAL_TIMEOUT]).toBe(504);
  });
});
