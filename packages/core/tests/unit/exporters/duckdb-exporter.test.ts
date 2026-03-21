import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DuckDBExporter } from '../../../src/exporters/duckdb-exporter.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const schema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'currency', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const entities = [
  { mergedData: { name: 'Widget', price: 9.99 }, qualityScore: 0.9, categories: [], sourceCount: 1 },
  { mergedData: { name: 'Gadget', price: 19.99 }, qualityScore: 0.8, categories: [], sourceCount: 1 },
];

describe('DuckDBExporter', () => {
  it('exports entities to valid DuckDB binary', async () => {
    const exporter = new DuckDBExporter();
    const result = await exporter.export(entities, schema, {
      format: 'duckdb',
      includeProvenance: false,
    });

    expect(result.format).toBe('duckdb');
    expect(result.entityCount).toBe(2);
    expect(result.binaryData).toBeInstanceOf(Uint8Array);
    expect(result.binaryData!.byteLength).toBeGreaterThan(0);

    // Write to temp file and verify by reopening
    const tmpPath = path.join(os.tmpdir(), `test-verify-${Date.now()}.duckdb`);
    try {
      fs.writeFileSync(tmpPath, result.binaryData!);
      const { DuckDBInstance } = await import('@duckdb/node-api');
      const instance = await DuckDBInstance.create(tmpPath);
      const conn = await instance.connect();
      // runAndReadAll returns a DuckDBResultReader with getRows()
      const reader = await conn.runAndReadAll('SELECT count(*) as cnt FROM entities');
      const rows = reader.getRows();
      expect(Number(rows[0][0])).toBe(2);
      conn.closeSync();
      instance.closeSync();
    } finally {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(`${tmpPath}.wal`, { force: true });
    }
  }, 30000);

  it('has format duckdb', () => {
    expect(new DuckDBExporter().format).toBe('duckdb');
  });
});
