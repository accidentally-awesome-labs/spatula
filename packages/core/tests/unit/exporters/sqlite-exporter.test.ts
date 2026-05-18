import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteExporter } from '../../../src/exporters/sqlite-exporter.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const schema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'currency', required: false },
    { name: 'tags', description: 'Tags', type: 'array', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const entities = [
  {
    mergedData: { name: 'Widget', price: 9.99, tags: ['sale', 'new'] },
    qualityScore: 0.9,
    categories: [],
    sourceCount: 1,
  },
  {
    mergedData: { name: 'Gadget', price: null, tags: null },
    qualityScore: 0.8,
    categories: [],
    sourceCount: 1,
  },
];

describe('SqliteExporter', () => {
  it('exports entities to valid SQLite binary', async () => {
    const exporter = new SqliteExporter();
    const result = await exporter.export(entities, schema, {
      format: 'sqlite',
      includeProvenance: false,
    });

    expect(result.format).toBe('sqlite');
    expect(result.entityCount).toBe(2);
    expect(result.binaryData).toBeInstanceOf(Uint8Array);
    expect(result.binaryData!.byteLength).toBeGreaterThan(0);

    // Read back and verify
    const db = new Database(Buffer.from(result.binaryData!));
    const rows = db.prepare('SELECT * FROM entities').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Widget');
    expect(rows[0].price).toBe(9.99);
    expect(JSON.parse(rows[0].tags)).toEqual(['sale', 'new']);
    expect(rows[1].price).toBeNull();
    db.close();
  });

  it('has format sqlite', () => {
    expect(new SqliteExporter().format).toBe('sqlite');
  });
});
