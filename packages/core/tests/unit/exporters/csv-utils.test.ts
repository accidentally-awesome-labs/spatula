import { describe, it, expect } from 'vitest';
import {
  csvEscapeValue,
  csvEscapeHeader,
  entityToCsvRow,
  entitiesToCsv,
} from '../../../src/exporters/csv-utils.js';
import type { Entity } from '@spatula/shared';

// Minimal Entity fixture
function makeEntity(mergedData: Record<string, unknown>): Entity {
  return {
    id: 'test-id',
    jobId: 'test-job',
    mergedData,
    qualityScore: 1,
    categories: [],
    sourceCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Entity;
}

describe('csvEscapeValue', () => {
  it('returns plain strings unchanged', () => {
    expect(csvEscapeValue('hello')).toBe('hello');
    expect(csvEscapeValue('world 123')).toBe('world 123');
  });

  it('quotes values that contain commas', () => {
    expect(csvEscapeValue('a,b')).toBe('"a,b"');
  });

  it('quotes values that contain double-quotes and doubles inner quotes', () => {
    expect(csvEscapeValue('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values that contain newlines', () => {
    expect(csvEscapeValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('sanitizes formula injection prefix =', () => {
    const result = csvEscapeValue('=SUM(A1)');
    expect(result).toBe('"\t=SUM(A1)"');
  });

  it('sanitizes formula injection prefix +', () => {
    const result = csvEscapeValue('+1');
    expect(result).toBe('"\t+1"');
  });

  it('sanitizes formula injection prefix -', () => {
    const result = csvEscapeValue('-1');
    expect(result).toBe('"\t-1"');
  });

  it('sanitizes formula injection prefix @', () => {
    const result = csvEscapeValue('@SUM');
    expect(result).toBe('"\t@SUM"');
  });

  it('does not sanitize non-formula strings', () => {
    expect(csvEscapeValue('hello=world')).toBe('hello=world');
  });
});

describe('csvEscapeHeader', () => {
  it('returns plain headers unchanged', () => {
    expect(csvEscapeHeader('name')).toBe('name');
    expect(csvEscapeHeader('price_usd')).toBe('price_usd');
  });

  it('quotes headers that contain commas', () => {
    expect(csvEscapeHeader('first,last')).toBe('"first,last"');
  });

  it('quotes headers that contain double-quotes and doubles inner quotes', () => {
    expect(csvEscapeHeader('col"name')).toBe('"col""name"');
  });

  it('quotes headers that contain newlines', () => {
    expect(csvEscapeHeader('col\nname')).toBe('"col\nname"');
  });
});

describe('entityToCsvRow', () => {
  it('serializes entity fields in column order', () => {
    const entity = makeEntity({ name: 'Alice', age: 30 });
    expect(entityToCsvRow(entity, ['name', 'age'])).toBe('Alice,30');
  });

  it('returns empty string for null values', () => {
    const entity = makeEntity({ name: null });
    expect(entityToCsvRow(entity, ['name'])).toBe('');
  });

  it('returns empty string for undefined values', () => {
    const entity = makeEntity({ name: undefined });
    expect(entityToCsvRow(entity, ['name'])).toBe('');
  });

  it('serializes object values as JSON', () => {
    const entity = makeEntity({ tags: ['a', 'b'] });
    const row = entityToCsvRow(entity, ['tags']);
    expect(row).toBe('"[""a"",""b""]"');
  });

  it('handles missing fields gracefully', () => {
    const entity = makeEntity({ name: 'Bob' });
    expect(entityToCsvRow(entity, ['name', 'missing'])).toBe('Bob,');
  });
});

describe('entitiesToCsv', () => {
  it('produces a header row followed by data rows', () => {
    const entities = [makeEntity({ name: 'Alice', city: 'NYC' })];
    const csv = entitiesToCsv(entities, ['name', 'city']);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('name,city');
    expect(lines[1]).toBe('Alice,NYC');
  });

  it('produces correct CSV for multiple entities', () => {
    const entities = [makeEntity({ name: 'Alice', age: 30 }), makeEntity({ name: 'Bob', age: 25 })];
    const csv = entitiesToCsv(entities, ['name', 'age']);
    expect(csv).toBe('name,age\nAlice,30\nBob,25');
  });

  it('handles an empty entities array (header only)', () => {
    const csv = entitiesToCsv([], ['name', 'age']);
    expect(csv).toBe('name,age');
  });
});
