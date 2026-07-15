import type { Entity } from '@accidentally-awesome-labs/spatula-shared';

export const FORMULA_PREFIXES = ['=', '+', '-', '@'];

export function csvEscapeValue(str: string): string {
  // RFC 4180: quote if contains comma, double-quote, or newline; double inner quotes
  const needsQuoting = str.includes(',') || str.includes('"') || str.includes('\n');
  // CSV injection: prefix formula-triggering characters with a tab
  const needsSanitize = FORMULA_PREFIXES.some((p) => str.startsWith(p));

  if (needsQuoting || needsSanitize) {
    const escaped = str.replace(/"/g, '""');
    return needsSanitize ? `"\t${escaped}"` : `"${escaped}"`;
  }
  return str;
}

export function csvEscapeHeader(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function entityToCsvRow(entity: Entity, fields: string[]): string {
  return fields
    .map((field) => {
      const val = entity.mergedData[field];
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return csvEscapeValue(str);
    })
    .join(',');
}

export function entitiesToCsv(entities: Entity[], fields: string[]): string {
  const header = fields.map(csvEscapeHeader).join(',');
  const rows = entities.map((e) => entityToCsvRow(e, fields));
  return [header, ...rows].join('\n');
}
