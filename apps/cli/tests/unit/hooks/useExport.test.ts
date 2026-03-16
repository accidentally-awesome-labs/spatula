import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe('useExport', () => {
  it('module exports useExport function', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    expect(typeof mod.useExport).toBe('function');
  });
});

describe('entityToCsvRow (exported for testing)', () => {
  it('serializes entity fields to CSV row', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    const row = mod.entityToCsvRow(
      { mergedData: { name: 'Test', price: '$10' } } as any,
      ['name', 'price'],
    );
    expect(row).toBe('Test,$10');
  });

  it('escapes values with commas per RFC 4180', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    const row = mod.entityToCsvRow(
      { mergedData: { name: 'Bose, Inc', price: '$10' } } as any,
      ['name', 'price'],
    );
    expect(row).toBe('"Bose, Inc",$10');
  });

  it('escapes values with quotes per RFC 4180', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    const row = mod.entityToCsvRow(
      { mergedData: { name: 'Say "hello"', price: '$10' } } as any,
      ['name', 'price'],
    );
    expect(row).toBe('"Say ""hello""",$10');
  });

  it('escapes values with newlines', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    const row = mod.entityToCsvRow(
      { mergedData: { name: 'Line1\nLine2' } } as any,
      ['name'],
    );
    expect(row).toBe('"Line1\nLine2"');
  });

  it('handles null and undefined values', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    const row = mod.entityToCsvRow(
      { mergedData: { name: null, price: undefined } } as any,
      ['name', 'price'],
    );
    expect(row).toBe(',');
  });

  it('serializes objects as JSON strings with proper escaping', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    const row = mod.entityToCsvRow(
      { mergedData: { data: { nested: true } } } as any,
      ['data'],
    );
    // JSON is {"nested":true}, RFC 4180 escaped: inner quotes doubled
    expect(row).toBe('"{""nested"":true}"');
  });

  it('sanitizes formula injection prefixes', async () => {
    const mod = await import('../../../src/hooks/useExport.js');
    const row = mod.entityToCsvRow(
      { mergedData: { name: '=CMD("hack")' } } as any,
      ['name'],
    );
    // Formula prefix gets tab-prefixed inside quotes
    expect(row.startsWith('"\t')).toBe(true);
    expect(row.startsWith('"=')).toBe(false);
  });
});
