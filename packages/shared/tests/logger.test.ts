import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger, createLoggerWithContext } from '../src/logger.js';
import { ConfigError } from '../src/errors.js';

describe('createLogger', () => {
  it('creates a logger with a given name', () => {
    const logger = createLogger('test-module');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('creates a child logger', () => {
    const logger = createLogger('parent');
    const child = logger.child({ component: 'child' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });

  it('reuses the pino transport across module loggers', () => {
    const before = process.listenerCount('exit');
    for (let i = 0; i < 25; i++) {
      createLogger(`module-${i}`);
    }
    const after = process.listenerCount('exit');

    expect(after - before).toBeLessThanOrEqual(1);
  });
});

describe('createLoggerWithContext', () => {
  it('creates a child logger with context fields', () => {
    const logger = createLoggerWithContext('test', { jobId: 'job-1', tenantId: 'tenant-1' });
    expect(logger).toBeDefined();
    const bindings = logger.bindings();
    expect(bindings.jobId).toBe('job-1');
    expect(bindings.tenantId).toBe('tenant-1');
  });

  it('omits undefined context fields', () => {
    const logger = createLoggerWithContext('test', { requestId: 'req-1' });
    const bindings = logger.bindings();
    expect(bindings.requestId).toBe('req-1');
    expect(bindings.jobId).toBeUndefined();
  });
});

describe('LOG_LEVEL validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws ConfigError for invalid LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'verbose');
    expect(() => createLogger('test')).toThrow(ConfigError);
  });

  it('accepts valid LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const logger = createLogger('test');
    expect(logger.level).toBe('debug');
  });
});
