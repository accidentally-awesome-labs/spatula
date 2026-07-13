import { describe, it, expect } from 'vitest';
import { redactValue, redactObject, REDACT_PATHS, REDACTED_PLACEHOLDER } from './redactor.js';

const PLACEHOLDER = '[REDACTED]';

// --- Positive cases: each pattern must be replaced ---

describe('redactValue — OpenRouter / OpenAI sk- keys', () => {
  it('replaces sk- key with ≥20-char body', () => {
    const raw = 'Authorization: sk-abcdefghij1234567890';
    expect(redactValue(raw)).toContain(PLACEHOLDER);
    expect(redactValue(raw)).not.toContain('sk-abcdefghij1234567890');
  });

  it('leaves short sk- strings unchanged', () => {
    const raw = 'sk-short';
    expect(redactValue(raw)).toBe(raw);
  });
});

describe('redactValue — Bearer tokens', () => {
  it('replaces Bearer <token> where token ≥20 chars', () => {
    const raw = 'Bearer abcdefghij1234567890XYZ';
    expect(redactValue(raw)).toContain(PLACEHOLDER);
    expect(redactValue(raw)).not.toContain('abcdefghij1234567890XYZ');
  });

  it('leaves Bearer with short token unchanged', () => {
    const raw = 'Bearer shorttoken';
    expect(redactValue(raw)).toBe(raw);
  });
});

describe('redactValue — JWTs (3-segment base64url)', () => {
  it('replaces a well-formed JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummysignatureXXXXXXXX';
    expect(redactValue(jwt)).toContain(PLACEHOLDER);
    expect(redactValue(jwt)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('leaves non-JWT ey-prefixed string unchanged if segments are too short', () => {
    const raw = 'ey.short.here';
    expect(redactValue(raw)).toBe(raw);
  });
});

describe('redactValue — Stripe live keys', () => {
  it('replaces sk_live_ key', () => {
    const raw = 'sk_live_abcdefghij1234567890';
    expect(redactValue(raw)).toContain(PLACEHOLDER);
    expect(redactValue(raw)).not.toContain('sk_live_abcdefghij1234567890');
  });

  it('leaves sk_live_ with short body unchanged', () => {
    const raw = 'sk_live_short';
    expect(redactValue(raw)).toBe(raw);
  });
});

describe('redactValue — Stripe test keys', () => {
  it('replaces sk_test_ key', () => {
    const raw = 'sk_test_abcdefghij1234567890';
    expect(redactValue(raw)).toContain(PLACEHOLDER);
    expect(redactValue(raw)).not.toContain('sk_test_abcdefghij1234567890');
  });

  it('leaves sk_test_ with short body unchanged', () => {
    const raw = 'sk_test_short';
    expect(redactValue(raw)).toBe(raw);
  });
});

describe('redactValue — OpenRouter alternate or- prefix', () => {
  it('replaces or- key with ≥20-char body', () => {
    const raw = 'or-abcdefghij1234567890xx';
    expect(redactValue(raw)).toContain(PLACEHOLDER);
    expect(redactValue(raw)).not.toContain('or-abcdefghij1234567890xx');
  });

  it('leaves short or- strings unchanged', () => {
    const raw = 'or-short';
    expect(redactValue(raw)).toBe(raw);
  });
});

describe('redactValue — clean strings', () => {
  it('returns a clean string unchanged', () => {
    const raw = 'just a normal log message with no secrets';
    expect(redactValue(raw)).toBe(raw);
  });

  it('returns empty string unchanged', () => {
    expect(redactValue('')).toBe('');
  });
});

// --- redactObject ---

describe('redactObject', () => {
  it('redacts secrets in top-level string values', () => {
    const obj = { key: 'sk-abcdefghij1234567890', safe: 'hello' };
    const result = redactObject(obj);
    expect(result.key).toBe(PLACEHOLDER);
    expect(result.safe).toBe('hello');
  });

  it('redacts secrets in nested objects', () => {
    const obj = {
      auth: {
        token: 'Bearer abcdefghij1234567890XYZ',
      },
    };
    const result = redactObject(obj);
    expect(result.auth.token).toBe(PLACEHOLDER);
  });

  it('redacts secrets in arrays', () => {
    const obj = { keys: ['sk-abcdefghij1234567890', 'clean'] };
    const result = redactObject(obj);
    expect(result.keys[0]).toBe(PLACEHOLDER);
    expect(result.keys[1]).toBe('clean');
  });

  it('handles null leaves without throwing', () => {
    const obj = { a: null, b: undefined };
    expect(() => redactObject(obj)).not.toThrow();
  });

  it('handles deeply nested structures without throwing', () => {
    const obj = {
      level1: {
        level2: {
          level3: {
            secret: 'sk-abcdefghij1234567890',
            num: 42,
          },
        },
      },
    };
    const result = redactObject(obj);
    expect(result.level1.level2.level3.secret).toBe(PLACEHOLDER);
    expect(result.level1.level2.level3.num).toBe(42);
  });

  it('does NOT mutate the input object', () => {
    const input = {
      secret: 'sk-abcdefghij1234567890',
      nested: { token: 'Bearer abcdefghij1234567890XYZ' },
    };
    const originalSnapshot = JSON.parse(JSON.stringify(input));
    redactObject(input);
    expect(input).toEqual(originalSnapshot);
  });

  it('returns a deep copy (not the same reference)', () => {
    const input = { a: 'hello' };
    const result = redactObject(input);
    expect(result).not.toBe(input);
  });
});

// --- REDACT_PATHS ---

describe('REDACT_PATHS', () => {
  it('is a non-empty array of strings', () => {
    expect(Array.isArray(REDACT_PATHS)).toBe(true);
    expect(REDACT_PATHS.length).toBeGreaterThan(0);
    for (const p of REDACT_PATHS) {
      expect(typeof p).toBe('string');
    }
  });

  it('covers req.headers.authorization', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
  });

  it('covers req.headers.cookie', () => {
    expect(REDACT_PATHS).toContain('req.headers.cookie');
  });
});

// --- REDACTED_PLACEHOLDER ---

describe('REDACTED_PLACEHOLDER', () => {
  it('equals [REDACTED]', () => {
    expect(REDACTED_PLACEHOLDER).toBe('[REDACTED]');
  });
});
