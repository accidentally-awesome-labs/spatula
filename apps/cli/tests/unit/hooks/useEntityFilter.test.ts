import { describe, it, expect } from 'vitest';
import { filterEntitiesLocally } from '../../../src/hooks/useEntityFilter.js';
import type { Entity } from '@accidentally-awesome-labs/spatula-shared';

describe('filterEntitiesLocally', () => {
  const entities: Entity[] = [
    {
      id: '1',
      mergedData: { name: 'Apple iPhone' },
      qualityScore: 0.9,
      categories: [],
      sourceCount: 1,
    } as Entity,
    {
      id: '2',
      mergedData: { name: 'Samsung Galaxy' },
      qualityScore: 0.8,
      categories: [],
      sourceCount: 1,
    } as Entity,
  ];

  it('filters case-insensitively', () => {
    const result = filterEntitiesLocally(entities, 'iphone');
    expect(result).toHaveLength(1);
    expect((result[0] as any).id).toBe('1');
  });

  it('returns all when query is empty', () => {
    expect(filterEntitiesLocally(entities, '')).toHaveLength(2);
  });
});
