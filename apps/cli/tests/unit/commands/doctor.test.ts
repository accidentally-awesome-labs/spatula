import { describe, it, expect } from 'vitest';
import {
  formatCheckResults,
  determineCategoriesFromContext,
} from '../../../src/commands/doctor.js';

describe('spatula doctor', () => {
  it('formats pass results', () => {
    const output = formatCheckResults([
      { name: 'node-version', category: 'system', status: 'pass', message: 'v22.0.0' },
    ]);
    expect(output).toContain('node-version');
    expect(output).toContain('v22.0.0');
    expect(output).toContain('PASS');
  });

  it('formats fail results', () => {
    const output = formatCheckResults([
      { name: 'postgres', category: 'server', status: 'fail', message: 'Connection refused' },
    ]);
    expect(output).toContain('FAIL');
    expect(output).toContain('Connection refused');
  });

  it('formats warn results', () => {
    const output = formatCheckResults([
      { name: 'docker', category: 'system', status: 'warn', message: 'Not available' },
    ]);
    expect(output).toContain('WARN');
  });

  it('shows summary counts', () => {
    const output = formatCheckResults([
      { name: 'a', category: 'system', status: 'pass', message: 'OK' },
      { name: 'b', category: 'system', status: 'warn', message: 'Meh' },
      { name: 'c', category: 'server', status: 'fail', message: 'Bad' },
    ]);
    expect(output).toContain('1 passed');
    expect(output).toContain('1 warnings');
    expect(output).toContain('1 failed');
  });

  it('determines system-only when no .env and no project', () => {
    const cats = determineCategoriesFromContext({ hasEnv: false, hasProject: false });
    expect(cats).toEqual(['system']);
  });

  it('adds server category when .env exists', () => {
    const cats = determineCategoriesFromContext({ hasEnv: true, hasProject: false });
    expect(cats).toContain('system');
    expect(cats).toContain('server');
  });

  it('adds project category when spatula.yaml exists', () => {
    const cats = determineCategoriesFromContext({ hasEnv: false, hasProject: true });
    expect(cats).toContain('system');
    expect(cats).toContain('project');
  });
});
