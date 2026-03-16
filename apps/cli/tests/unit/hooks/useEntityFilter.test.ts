import { describe, it, expect, vi } from 'vitest';

describe('useEntityFilter', () => {
  it('module exports useEntityFilter function', async () => {
    const mod = await import('../../../src/hooks/useEntityFilter.js');
    expect(typeof mod.useEntityFilter).toBe('function');
  });

  it('exports filterEntitiesLocally for testing', async () => {
    const mod = await import('../../../src/hooks/useEntityFilter.js');
    expect(typeof mod.filterEntitiesLocally).toBe('function');
  });
});

describe('filterEntitiesLocally', () => {
  it('filters entities by text match across all field values', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: 'Bluetooth Speaker', price: '$49' } },
      { id: 'e2', mergedData: { name: 'Wired Headphones', price: '$25' } },
      { id: 'e3', mergedData: { name: 'Bluetooth Earbuds', price: '$79' } },
    ];
    const result = filterEntitiesLocally(entities as any, 'bluetooth');
    expect(result).toHaveLength(2);
    expect(result.map((e: any) => e.id)).toEqual(['e1', 'e3']);
  });

  it('is case-insensitive', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: 'SONY Headphones' } },
    ];
    const result = filterEntitiesLocally(entities as any, 'sony');
    expect(result).toHaveLength(1);
  });

  it('returns all entities for empty query', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: 'A' } },
      { id: 'e2', mergedData: { name: 'B' } },
    ];
    const result = filterEntitiesLocally(entities as any, '');
    expect(result).toHaveLength(2);
  });

  it('matches across multiple fields', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: 'Speaker', brand: 'JBL' } },
      { id: 'e2', mergedData: { name: 'JBL Flip', brand: 'JBL' } },
    ];
    const result = filterEntitiesLocally(entities as any, 'jbl');
    expect(result).toHaveLength(2);
  });

  it('handles null and undefined values gracefully', async () => {
    const { filterEntitiesLocally } = await import('../../../src/hooks/useEntityFilter.js');
    const entities = [
      { id: 'e1', mergedData: { name: null, price: undefined } },
      { id: 'e2', mergedData: { name: 'Test' } },
    ];
    const result = filterEntitiesLocally(entities as any, 'test');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('e2');
  });
});
