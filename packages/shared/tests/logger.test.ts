import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';

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
});
