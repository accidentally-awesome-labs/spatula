import { describe, it, expect } from 'vitest';
import { createSystemChecks } from '../../../src/diagnostics/system-checks.js';

describe('System Health Checks', () => {
  it('creates 5 system checks', () => {
    const checks = createSystemChecks();
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.category === 'system')).toBe(true);
  });

  it('node-version check passes for current Node.js', async () => {
    const checks = createSystemChecks();
    const nodeCheck = checks.find((c) => c.name === 'node-version')!;
    const result = await nodeCheck.run();
    expect(result.status).toBe('pass');
  });

  it('all checks have name and category', () => {
    const checks = createSystemChecks();
    for (const check of checks) {
      expect(check.name).toBeTruthy();
      expect(check.category).toBe('system');
      expect(typeof check.run).toBe('function');
    }
  });
});
