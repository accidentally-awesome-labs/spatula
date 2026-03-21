import type { SchemaDefinition } from '../types/schema.js';

export type ExportTarget = 'parquet' | 'duckdb' | 'sqlite';

export interface ColumnDef {
  name: string;
  nativeType: string;
  nullable: boolean;
}

const TYPE_MAP: Record<string, Record<ExportTarget, string>> = {
  string:   { parquet: 'UTF8',    duckdb: 'VARCHAR',       sqlite: 'TEXT' },
  number:   { parquet: 'DOUBLE',  duckdb: 'DOUBLE',        sqlite: 'REAL' },
  boolean:  { parquet: 'BOOLEAN', duckdb: 'BOOLEAN',       sqlite: 'INTEGER' },
  url:      { parquet: 'UTF8',    duckdb: 'VARCHAR',       sqlite: 'TEXT' },
  currency: { parquet: 'DOUBLE',  duckdb: 'DECIMAL(19,4)', sqlite: 'REAL' },
  enum:     { parquet: 'UTF8',    duckdb: 'VARCHAR',       sqlite: 'TEXT' },
  array:    { parquet: 'UTF8',    duckdb: 'VARCHAR',       sqlite: 'TEXT' },
  object:   { parquet: 'UTF8',    duckdb: 'VARCHAR',       sqlite: 'TEXT' },
};

export function mapSchema(schema: SchemaDefinition, target: ExportTarget): ColumnDef[] {
  return schema.fields.map((field) => ({
    name: field.name,
    nativeType: TYPE_MAP[field.type]?.[target] ?? TYPE_MAP.string[target],
    nullable: !field.required,
  }));
}
