import { describe, it, expect, vi } from 'vitest';
import { HealthCheckRegistry } from '../../../src/diagnostics/health-check.js';
import type { HealthCheck } from '../../../src/diagnostics/health-check.js';

describe('HealthCheckRegistry', () => {
  it('registers and runs checks by category', async () => {
    const registry = new HealthCheckRegistry();

    const systemCheck: HealthCheck = {
      name: 'node-version',
      category: 'system',
      run: vi.fn().mockResolvedValue({ status: 'pass', message: 'v22.0.0' }),
    };

    const serverCheck: HealthCheck = {
      name: 'postgres',
      category: 'server',
      run: vi.fn().mockResolvedValue({ status: 'fail', message: 'Connection refused' }),
    };

    registry.register(systemCheck);
    registry.register(serverCheck);

    const results = await registry.runChecks(['system']);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('node-version');
    expect(results[0].status).toBe('pass');
  });

  it('runs multiple categories', async () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: 'check-a',
      category: 'system',
      run: async () => ({ status: 'pass', message: 'OK' }),
    });

    registry.register({
      name: 'check-b',
      category: 'server',
      run: async () => ({ status: 'warn', message: 'Slow' }),
    });

    const results = await registry.runChecks(['system', 'server']);
    expect(results).toHaveLength(2);
  });

  it('catches errors in checks and reports as fail', async () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: 'broken',
      category: 'system',
      run: async () => { throw new Error('Unexpected'); },
    });

    const results = await registry.runChecks(['system']);
    expect(results[0].status).toBe('fail');
    expect(results[0].message).toContain('Unexpected');
  });

  it('returns empty results for unknown category', async () => {
    const registry = new HealthCheckRegistry();
    const results = await registry.runChecks(['project']);
    expect(results).toEqual([]);
  });
});
