import { describe, it, expect, vi } from 'vitest';
import { createServerChecks } from '../../../src/diagnostics/server-checks.js';

describe('Server Health Checks', () => {
  it('creates 4 server checks', () => {
    const checks = createServerChecks({});
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.category === 'server')).toBe(true);
  });

  it('postgres check uses provided tester', async () => {
    const checks = createServerChecks({
      checkPostgres: vi.fn().mockResolvedValue({ status: 'pass', message: 'Connected' }),
    });
    const pgCheck = checks.find((c) => c.name === 'postgres')!;
    const result = await pgCheck.run();
    expect(result.status).toBe('pass');
  });

  it('postgres check fails when no tester and no URL', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const checks = createServerChecks({});
      const pgCheck = checks.find((c) => c.name === 'postgres')!;
      const result = await pgCheck.run();
      expect(result.status).toBe('fail');
    } finally {
      if (original) process.env.DATABASE_URL = original;
    }
  });

  it('redis check uses provided tester', async () => {
    const checks = createServerChecks({
      checkRedis: vi.fn().mockResolvedValue({ status: 'pass', message: 'PONG' }),
    });
    const redisCheck = checks.find((c) => c.name === 'redis')!;
    const result = await redisCheck.run();
    expect(result.status).toBe('pass');
  });

  it('migrations check uses provided tester', async () => {
    const checks = createServerChecks({
      checkMigrations: vi.fn().mockResolvedValue({ status: 'pass', message: '15 migrations applied' }),
    });
    const migCheck = checks.find((c) => c.name === 'migrations')!;
    const result = await migCheck.run();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('15');
  });

  it('migrations check warns when no tester provided', async () => {
    const checks = createServerChecks({});
    const migCheck = checks.find((c) => c.name === 'migrations')!;
    const result = await migCheck.run();
    expect(result.status).toBe('warn');
  });
});
