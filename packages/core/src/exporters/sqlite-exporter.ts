import Database from 'better-sqlite3';
import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';
import { mapSchema } from './column-mapper.js';

export class SqliteExporter implements Exporter {
  readonly format = 'sqlite' as const;

  async export(
    entities: unknown[],
    schema: SchemaDefinition,
    _options: ExportOptions,
  ): Promise<ExportResult> {
    const columns = mapSchema(schema, 'sqlite');
    const db = new Database(':memory:');

    try {
      // Create table
      const colDefs = columns
        .map((c) => `"${c.name}" ${c.nativeType}${c.nullable ? '' : ' NOT NULL'}`)
        .join(', ');
      db.prepare(`CREATE TABLE entities (${colDefs})`).run();

      // Insert in transaction
      const placeholders = columns.map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO entities VALUES (${placeholders})`);

      const insertMany = db.transaction((rows: unknown[][]) => {
        for (const row of rows) insert.run(...row);
      });

      const rows = entities.map((entity: any) => {
        const data = entity.mergedData ?? {};
        return columns.map((col) => {
          const val = data[col.name];
          if (val === undefined || val === null) return null;
          if (typeof val === 'object') return JSON.stringify(val);
          if (typeof val === 'boolean') return val ? 1 : 0;
          return val;
        });
      });

      insertMany(rows);

      // Serialize to binary
      const buffer = db.serialize();
      const binaryData = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

      return {
        format: 'sqlite',
        entityCount: entities.length,
        binaryData,
        generatedAt: new Date(),
      };
    } finally {
      db.close();
    }
  }
}
