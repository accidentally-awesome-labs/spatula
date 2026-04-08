// apps/cli/tests/unit/lib/schema-diff.test.ts
import { describe, it, expect } from 'vitest';
import { diffSchemas } from '../../../src/lib/schema-diff.js';
import type { SchemaDiff } from '../../../src/lib/schema-diff.js';

function field(name: string, type = 'string', required = false) {
  return { name, description: `${name} field`, type, required };
}

function schema(fields: unknown[], version = 1) {
  return {
    version,
    fields,
    fieldAliases: [],
    createdAt: new Date('2026-01-01'),
    parentVersion: null,
  };
}

describe('diffSchemas', () => {
  it('returns no changes for identical schemas', () => {
    const s = schema([field('name'), field('price', 'currency')]);
    const diff = diffSchemas(s, s);
    expect(diff.hasChanges).toBe(false);
    expect(diff.localOnly).toHaveLength(0);
    expect(diff.remoteOnly).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(2);
  });

  it('detects fields only in local', () => {
    const local = schema([field('name'), field('color')]);
    const remote = schema([field('name')]);
    const diff = diffSchemas(local, remote);
    expect(diff.hasChanges).toBe(true);
    expect(diff.localOnly).toHaveLength(1);
    expect(diff.localOnly[0].name).toBe('color');
  });

  it('detects fields only in remote', () => {
    const local = schema([field('name')]);
    const remote = schema([field('name'), field('price', 'currency')]);
    const diff = diffSchemas(local, remote);
    expect(diff.hasChanges).toBe(true);
    expect(diff.remoteOnly).toHaveLength(1);
    expect(diff.remoteOnly[0].name).toBe('price');
  });

  it('detects type changes in shared fields', () => {
    const local = schema([field('price', 'string')]);
    const remote = schema([field('price', 'currency')]);
    const diff = diffSchemas(local, remote);
    expect(diff.hasChanges).toBe(true);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].name).toBe('price');
    expect(diff.changed[0].differences).toContain('type: string → currency');
  });

  it('detects required flag changes', () => {
    const local = schema([field('name', 'string', false)]);
    const remote = schema([field('name', 'string', true)]);
    const diff = diffSchemas(local, remote);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].differences).toContain('required: false → true');
  });

  it('handles empty schemas', () => {
    const diff = diffSchemas(schema([]), schema([]));
    expect(diff.hasChanges).toBe(false);
    expect(diff.unchanged).toHaveLength(0);
  });

  it('handles one empty schema against a populated one', () => {
    const diff = diffSchemas(schema([]), schema([field('a'), field('b')]));
    expect(diff.hasChanges).toBe(true);
    expect(diff.remoteOnly).toHaveLength(2);
    expect(diff.localOnly).toHaveLength(0);
  });
});
