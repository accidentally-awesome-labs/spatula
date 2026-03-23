import { describe, it, expect } from 'vitest';
import { parseEnabledWorkers, isWorkerEnabled } from '../../src/worker-selection.js';

describe('parseEnabledWorkers', () => {
  it('returns ["all"] when no argument is provided', () => {
    expect(parseEnabledWorkers()).toEqual(['all']);
  });

  it('returns ["all"] when passed undefined', () => {
    expect(parseEnabledWorkers(undefined)).toEqual(['all']);
  });

  it('returns ["all"] when passed "all"', () => {
    expect(parseEnabledWorkers('all')).toEqual(['all']);
  });

  it('splits comma-separated values', () => {
    expect(parseEnabledWorkers('crawl,export')).toEqual(['crawl', 'export']);
  });

  it('trims whitespace from each entry', () => {
    expect(parseEnabledWorkers(' crawl , export ')).toEqual(['crawl', 'export']);
  });

  it('lowercases all entries', () => {
    expect(parseEnabledWorkers('Crawl,EXPORT')).toEqual(['crawl', 'export']);
  });

  it('filters out empty strings from double commas', () => {
    expect(parseEnabledWorkers('crawl,,export')).toEqual(['crawl', 'export']);
  });

  it('handles single worker', () => {
    expect(parseEnabledWorkers('crawl')).toEqual(['crawl']);
  });

  it('handles empty string by returning ["all"] equivalent empty filter', () => {
    // Empty string splits to [''], all get trimmed/filtered to [], but
    // since we default to 'all' only when envValue is undefined, empty string
    // produces no entries — meaning no workers enabled. This is intentional:
    // setting SPATULA_WORKERS="" disables all workers.
    expect(parseEnabledWorkers('')).toEqual([]);
  });
});

describe('isWorkerEnabled', () => {
  it('returns true when list contains "all"', () => {
    expect(isWorkerEnabled(['all'], 'crawl')).toBe(true);
    expect(isWorkerEnabled(['all'], 'export')).toBe(true);
    expect(isWorkerEnabled(['all'], 'reconciliation')).toBe(true);
  });

  it('returns true when worker name is in the list', () => {
    expect(isWorkerEnabled(['crawl', 'export'], 'crawl')).toBe(true);
    expect(isWorkerEnabled(['crawl', 'export'], 'export')).toBe(true);
  });

  it('returns false when worker name is NOT in the list', () => {
    expect(isWorkerEnabled(['crawl', 'export'], 'reconciliation')).toBe(false);
    expect(isWorkerEnabled(['crawl', 'export'], 'schema-evolution')).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(isWorkerEnabled([], 'crawl')).toBe(false);
  });

  it('is case-sensitive (expects pre-normalized input)', () => {
    expect(isWorkerEnabled(['crawl'], 'Crawl')).toBe(false);
  });
});
