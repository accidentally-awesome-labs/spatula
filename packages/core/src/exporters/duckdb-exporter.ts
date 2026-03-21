import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';
import { mapSchema } from './column-mapper.js';

export class DuckDBExporter implements Exporter {
  readonly format = 'duckdb' as const;

  async export(
    entities: unknown[],
    schema: SchemaDefinition,
    _options: ExportOptions,
  ): Promise<ExportResult> {
    const columns = mapSchema(schema, 'duckdb');
    const tmpPath = path.join(os.tmpdir(), `spatula-export-${crypto.randomUUID()}.duckdb`);

    try {
      // Import DuckDB dynamically to handle native binding loading
      const { DuckDBInstance } = await import('@duckdb/node-api');

      const instance = await DuckDBInstance.create(tmpPath);
      const conn = await instance.connect();

      // Create table
      const colDefs = columns
        .map((c) => `"${c.name}" ${c.nativeType}${c.nullable ? '' : ' NOT NULL'}`)
        .join(', ');
      await conn.run(`CREATE TABLE entities (${colDefs})`);

      // Insert in batches using VALUES with SQL literals
      const BATCH_SIZE = 500;
      for (let i = 0; i < entities.length; i += BATCH_SIZE) {
        const batch = entities.slice(i, i + BATCH_SIZE);
        const valueRows = batch.map((entity: any) => {
          const data = entity.mergedData ?? {};
          const vals = columns.map((col) => {
            const val = data[col.name];
            if (val === undefined || val === null) return 'NULL';
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
            if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
            return String(val);
          });
          return `(${vals.join(', ')})`;
        });
        await conn.run(`INSERT INTO entities VALUES ${valueRows.join(', ')}`);
      }

      // Close connection and instance to flush to disk
      conn.closeSync();
      instance.closeSync();

      // Read the file bytes
      const binaryData = new Uint8Array(await fs.readFile(tmpPath));

      return {
        format: 'duckdb',
        entityCount: entities.length,
        binaryData,
        generatedAt: new Date(),
      };
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      await fs.rm(`${tmpPath}.wal`, { force: true }).catch(() => {});
    }
  }
}
