import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEnvOrThrow, getEnvOrDefault, loadConfig, loadConfigSafe } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

describe('getEnvOrThrow', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the value if set', () => {
    vi.stubEnv('TEST_KEY', 'test_value');
    expect(getEnvOrThrow('TEST_KEY')).toBe('test_value');
  });

  it('throws if not set', () => {
    expect(() => getEnvOrThrow('MISSING_KEY')).toThrow('MISSING_KEY');
  });
});

describe('getEnvOrDefault', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the value if set', () => {
    vi.stubEnv('TEST_KEY', 'real_value');
    expect(getEnvOrDefault('TEST_KEY', 'default')).toBe('real_value');
  });

  it('returns default if not set', () => {
    expect(getEnvOrDefault('MISSING_KEY', 'fallback')).toBe('fallback');
  });
});

describe('loadConfig', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns validated config when all required env vars set', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-123');
    const config = loadConfig();
    expect(config.database.url).toBe('postgresql://localhost:5432/spatula');
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.openrouter.apiKey).toBe('sk-test-123');
    expect(config.server.port).toBe(3000);
    expect(config.logging.level).toBe('info');
  });

  it('throws ConfigError listing all issues when required vars missing', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => loadConfig()).toThrow(ConfigError);
    try { loadConfig(); } catch (e) {
      expect((e as ConfigError).message).toContain('database');
      expect((e as ConfigError).message).toContain('openrouter');
    }
  });

  it('applies defaults for optional fields', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubEnv('NODE_ENV', '');
    const config = loadConfig();
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.logging.nodeEnv).toBe('development');
  });

  it('accepts NODE_ENV=test', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubEnv('NODE_ENV', 'test');
    expect(loadConfig().logging.nodeEnv).toBe('test');
  });

  it('coerces PORT to number', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubEnv('PORT', '8080');
    expect(loadConfig().server.port).toBe(8080);
  });
});

describe('loadConfigSafe', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('returns config on success', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const result = loadConfigSafe();
    expect('config' in result).toBe(true);
  });
  it('returns errors on failure', () => {
    vi.stubEnv('DATABASE_URL', '');
    const result = loadConfigSafe();
    expect('errors' in result).toBe(true);
  });
});
