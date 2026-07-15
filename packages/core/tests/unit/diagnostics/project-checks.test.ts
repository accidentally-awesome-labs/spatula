import { describe, it, expect, vi } from 'vitest';
import { createProjectChecks } from '../../../src/diagnostics/project-checks.js';
import type { HealthCheck } from '../../../src/diagnostics/health-check.js';

describe('createProjectChecks', () => {
  it('returns 10 project checks', () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn().mockReturnValue(true),
    });
    expect(checks).toHaveLength(10);
    expect(checks.every((c: HealthCheck) => c.category === 'project')).toBe(true);
  });

  it('spatula-yaml check passes for valid config', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn().mockReturnValue(true),
    });
    const result = await checks.find((c) => c.name === 'spatula-yaml')!.run();
    expect(result.status).toBe('pass');
  });

  it('spatula-yaml check fails for invalid config', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn().mockImplementation(() => {
        throw new Error('Invalid YAML');
      }),
    });
    const result = await checks.find((c) => c.name === 'spatula-yaml')!.run();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Invalid YAML');
  });

  it('db-integrity check warns when no DB exists', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/nonexistent-dir-12345',
      validateYaml: vi.fn(),
    });
    const result = await checks.find((c) => c.name === 'db-integrity')!.run();
    expect(result.status).toBe('warn');
  });

  it('db-integrity check passes with custom checker returning ok', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/nonexistent-dir-12345',
      validateYaml: vi.fn(),
      checkDbIntegrity: vi.fn().mockResolvedValue({ ok: true, message: 'OK' }),
    });
    const result = await checks.find((c) => c.name === 'db-integrity')!.run();
    expect(result.status).toBe('warn'); // file doesn't exist
  });

  it('orphaned-tasks check returns warn when orphaned tasks exist', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn(),
      getOrphanedTaskCount: vi.fn().mockResolvedValue(3),
    });
    const result = await checks.find((c) => c.name === 'orphaned-tasks')!.run();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('3');
  });

  it('orphaned-tasks check passes when no orphaned tasks', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn(),
      getOrphanedTaskCount: vi.fn().mockResolvedValue(0),
    });
    const result = await checks.find((c) => c.name === 'orphaned-tasks')!.run();
    expect(result.status).toBe('pass');
  });

  it('schema-state warns when the project database has no extraction schema', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn(),
      getSchemaFieldCount: vi.fn().mockResolvedValue(null),
    });
    const result = await checks.find((c) => c.name === 'schema-state')!.run();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('No extraction schema');
    expect(result.message).toContain('spatula run');
  });

  it('schema-state passes for an initialized empty discovery schema', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn(),
      getSchemaFieldCount: vi.fn().mockResolvedValue(0),
    });
    const result = await checks.find((c) => c.name === 'schema-state')!.run();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('0 configured fields');
  });

  it('failed-tasks warns with the persisted crawl failure count', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn(),
      getFailedTaskCount: vi.fn().mockResolvedValue(2),
    });
    const result = await checks.find((c) => c.name === 'failed-tasks')!.run();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('2 crawl task');
    expect(result.message).toContain('logs --errors');
  });

  it('pending-actions check returns warn with count', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/test',
      validateYaml: vi.fn(),
      getPendingActionCount: vi.fn().mockResolvedValue(5),
    });
    const result = await checks.find((c) => c.name === 'pending-actions')!.run();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('5');
    expect(result.message).toContain('spatula review');
  });

  it('page-files check passes when no pages directory', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/nonexistent-dir-12345',
      validateYaml: vi.fn(),
    });
    const result = await checks.find((c) => c.name === 'page-files')!.run();
    expect(result.status).toBe('pass');
  });

  it('disk-usage check passes when no .spatula/ directory', async () => {
    const checks = createProjectChecks({
      projectRoot: '/tmp/nonexistent-dir-12345',
      validateYaml: vi.fn(),
    });
    const result = await checks.find((c) => c.name === 'disk-usage')!.run();
    expect(result.status).toBe('pass');
  });

  it('remote-link check returns pass with current setup guidance', async () => {
    const checks = createProjectChecks({ projectRoot: '/tmp/test', validateYaml: vi.fn() });
    const result = await checks.find((c) => c.name === 'remote-link')!.run();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('spatula remote add');
    expect(result.message).toContain('self-hosted API');
  });

  it('all 10 check names are unique', () => {
    const checks = createProjectChecks({ projectRoot: '/tmp/test', validateYaml: vi.fn() });
    const names = checks.map((c) => c.name);
    expect(new Set(names).size).toBe(10);
  });
});
