import { describe, it, expect } from 'vitest';
import { resolveOutputPath, validateFormat } from '../../../src/commands/export.js';

describe('validateFormat', () => {
  it.each(['json', 'csv', 'sqlite', 'parquet', 'duckdb'] as const)(
    'accepts valid format "%s"',
    (format) => {
      expect(validateFormat(format)).toBe(format);
    },
  );

  it('throws for an invalid format', () => {
    expect(() => validateFormat('xlsx')).toThrow('Unsupported export format "xlsx"');
  });

  it('throws for empty string', () => {
    expect(() => validateFormat('')).toThrow('Unsupported export format');
  });
});

describe('resolveOutputPath', () => {
  it('returns the provided path resolved to absolute when given', () => {
    const result = resolveOutputPath('/tmp/my-export.json', 'json', '/project');
    expect(result).toBe('/tmp/my-export.json');
  });

  it('generates a default path under .spatula/exports with correct extension', () => {
    const result = resolveOutputPath(undefined, 'csv', '/my/project');
    expect(result).toMatch(/^\/my\/project\/\.spatula\/exports\//);
    expect(result).toMatch(/\.csv$/);
  });

  it('generates a default path with sqlite extension', () => {
    const result = resolveOutputPath(undefined, 'sqlite', '/proj');
    expect(result).toMatch(/\.sqlite$/);
  });

  it('generates a default path with parquet extension', () => {
    const result = resolveOutputPath(undefined, 'parquet', '/proj');
    expect(result).toMatch(/\.parquet$/);
  });

  it('generates a default path with duckdb extension', () => {
    const result = resolveOutputPath(undefined, 'duckdb', '/proj');
    expect(result).toMatch(/\.duckdb$/);
  });

  it('generates a default path with json extension', () => {
    const result = resolveOutputPath(undefined, 'json', '/proj');
    expect(result).toMatch(/\.json$/);
  });

  it('resolves a relative provided path to absolute', () => {
    const result = resolveOutputPath('output/data.json', 'json', '/project');
    // Should be resolved to an absolute path (based on cwd, not projectRoot)
    expect(result).toMatch(/^\/.*output\/data\.json$/);
  });
});
