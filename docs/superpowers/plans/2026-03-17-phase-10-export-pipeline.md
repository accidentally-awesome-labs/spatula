# Phase 10: Export Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side export pipeline — async BullMQ-based export generation with JSON/CSV exporters, content store persistence, data dictionary generation, and CLI integration via API polling.

**Architecture:** Exporters are pure functions in the core package. The API creates export records and enqueues BullMQ jobs. An ExportWorker fetches entities, runs the exporter, writes to content store, and updates the export record. The CLI polls for status and downloads the result.

**Tech Stack:** Hono (API), BullMQ (queue), Drizzle ORM (DB), Vitest (tests), Zod (validation)

**Spec:** `docs/superpowers/specs/2026-03-17-phase-10-export-pipeline-design.md`

---

## Chunk 1: Core Exporters & Types

### Task 1: Extract CSV utilities from CLI to core

**Files:**
- Create: `packages/core/src/exporters/csv-utils.ts`
- Create: `packages/core/src/exporters/index.ts`
- Modify: `apps/cli/src/hooks/useExport.ts` (import from core instead of local copy)
- Create: `packages/core/tests/unit/exporters/csv-utils.test.ts`

The CLI `useExport.ts` already has working CSV functions. Extract them to a shared location.

- [ ] **Step 1: Write failing test for csv-utils**

```typescript
// packages/core/tests/unit/exporters/csv-utils.test.ts
import { describe, it, expect } from 'vitest';
import { csvEscapeValue, entityToCsvRow, entitiesToCsv, csvEscapeHeader } from '../../../src/exporters/csv-utils.js';

describe('csvEscapeValue', () => {
  it('returns plain strings unchanged', () => {
    expect(csvEscapeValue('hello')).toBe('hello');
  });

  it('quotes values with commas', () => {
    expect(csvEscapeValue('a,b')).toBe('"a,b"');
  });

  it('doubles inner quotes per RFC 4180', () => {
    expect(csvEscapeValue('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values with newlines', () => {
    expect(csvEscapeValue('a\nb')).toBe('"a\nb"');
  });

  it('sanitizes formula injection prefixes with tab', () => {
    expect(csvEscapeValue('=CMD()')).toMatch(/^"\t/);
    expect(csvEscapeValue('+1')).toMatch(/^"\t/);
    expect(csvEscapeValue('-1')).toMatch(/^"\t/);
    expect(csvEscapeValue('@SUM')).toMatch(/^"\t/);
  });
});

describe('csvEscapeHeader', () => {
  it('returns plain headers unchanged', () => {
    expect(csvEscapeHeader('name')).toBe('name');
  });

  it('quotes headers with commas', () => {
    expect(csvEscapeHeader('first,last')).toBe('"first,last"');
  });
});

describe('entityToCsvRow', () => {
  it('serializes entity fields', () => {
    const entity = { mergedData: { name: 'Test', price: '$10' } } as any;
    expect(entityToCsvRow(entity, ['name', 'price'])).toBe('Test,$10');
  });

  it('handles null and undefined', () => {
    const entity = { mergedData: { a: null, b: undefined } } as any;
    expect(entityToCsvRow(entity, ['a', 'b'])).toBe(',');
  });

  it('serializes objects as escaped JSON', () => {
    const entity = { mergedData: { data: { key: 'val' } } } as any;
    const row = entityToCsvRow(entity, ['data']);
    expect(row).toContain('key');
  });
});

describe('entitiesToCsv', () => {
  it('produces header + data rows', () => {
    const entities = [
      { mergedData: { name: 'A', price: '10' } },
      { mergedData: { name: 'B', price: '20' } },
    ] as any;
    const csv = entitiesToCsv(entities, ['name', 'price']);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('name,price');
    expect(lines).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/csv-utils.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create csv-utils.ts**

Copy the CSV functions from `apps/cli/src/hooks/useExport.ts` (the `csvEscapeValue`, `csvEscapeHeader`, `entityToCsvRow`, `entitiesToCsv` functions). Place them in `packages/core/src/exporters/csv-utils.ts`:

```typescript
// packages/core/src/exporters/csv-utils.ts
import type { Entity } from '@spatula/shared';

const FORMULA_PREFIXES = ['=', '+', '-', '@'];

export function csvEscapeValue(str: string): string {
  const needsQuoting = str.includes(',') || str.includes('"') || str.includes('\n');
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
```

- [ ] **Step 4: Create barrel export**

```typescript
// packages/core/src/exporters/index.ts
export { csvEscapeValue, csvEscapeHeader, entityToCsvRow, entitiesToCsv } from './csv-utils.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/csv-utils.test.ts`
Expected: All PASS.

- [ ] **Step 6: Update CLI useExport to import from core**

In `apps/cli/src/hooks/useExport.ts`, remove the local `csvEscapeValue`, `csvEscapeHeader`, `entityToCsvRow`, `entitiesToCsv`, and `FORMULA_PREFIXES` code. Replace with imports from `@spatula/core`:

```typescript
import { csvEscapeValue, entityToCsvRow, entitiesToCsv } from '@spatula/core';
```

Keep the `entitiesToJson`, `generateFilename`, and `useExport` hook function — only the CSV utilities move.

- [ ] **Step 7: Run CLI tests to verify no regressions**

Run: `cd apps/cli && pnpm test`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/exporters/ packages/core/tests/unit/exporters/ apps/cli/src/hooks/useExport.ts
git commit -m "refactor: extract CSV utilities from CLI to @spatula/core"
```

---

### Task 2: Exporter types (DataDictionary, FieldStats, FieldDocumentation)

**Files:**
- Create: `packages/core/src/exporters/types.ts`
- Modify: `packages/core/src/exporters/index.ts`

- [ ] **Step 1: Create types file**

```typescript
// packages/core/src/exporters/types.ts
export interface FieldStats {
  fillRate: number;
  uniqueCount: number;
  sampleValues: unknown[];
  min?: number;
  max?: number;
}

export interface FieldDocumentation {
  name: string;
  type: string;
  description: string;
  required: boolean;
  aliases: string[];
  stats: FieldStats;
}

export interface DataDictionary {
  jobId: string;
  schemaVersion: number;
  generatedAt: string;
  entityCount: number;
  sampled?: boolean;
  sampleSize?: number;
  fields: FieldDocumentation[];
}
```

- [ ] **Step 2: Add to barrel export**

In `packages/core/src/exporters/index.ts`, add:
```typescript
export type { DataDictionary, FieldStats, FieldDocumentation } from './types.js';
```

- [ ] **Step 3: Add exporters to core barrel export**

In `packages/core/src/index.ts`, add:
```typescript
export * from './exporters/index.js';
```

This makes all exporter utilities, types, and classes importable as `import { ... } from '@spatula/core'`.

- [ ] **Step 4: Verify build**

Run: `cd packages/core && pnpm build`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/exporters/types.ts packages/core/src/exporters/index.ts packages/core/src/index.ts
git commit -m "feat(core): add DataDictionary and FieldStats types for export"
```

---

### Task 3: DocumentationGenerator

**Files:**
- Create: `packages/core/src/exporters/documentation-generator.ts`
- Create: `packages/core/tests/unit/exporters/documentation-generator.test.ts`
- Modify: `packages/core/src/exporters/index.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/core/tests/unit/exporters/documentation-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateDocumentation } from '../../../src/exporters/documentation-generator.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { Entity } from '@spatula/shared';

const mockSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Price in USD', type: 'number', required: false },
    { name: 'brand', description: 'Brand name', type: 'string', required: false },
  ],
  fieldAliases: [
    { canonicalName: 'name', aliases: [{ name: 'title', sources: ['site-a.com'], occurrences: 3 }], mergedAt: new Date(), reasoning: 'synonym' },
  ],
  createdAt: new Date(),
  parentVersion: null,
};

const mockEntities: Entity[] = [
  { id: 'e1', jobId: 'j1', mergedData: { name: 'Widget A', price: 10, brand: 'Acme' }, categories: [], qualityScore: 0.9, createdAt: '', sourceCount: 2 },
  { id: 'e2', jobId: 'j1', mergedData: { name: 'Widget B', price: 20, brand: 'Acme' }, categories: [], qualityScore: 0.8, createdAt: '', sourceCount: 1 },
  { id: 'e3', jobId: 'j1', mergedData: { name: 'Widget C', price: null, brand: null }, categories: [], qualityScore: 0.7, createdAt: '', sourceCount: 1 },
] as any;

describe('generateDocumentation', () => {
  it('returns correct field count', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    expect(doc.fields).toHaveLength(3);
  });

  it('computes fillRate correctly', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.stats.fillRate).toBe(1); // 3/3 non-null
    const brandField = doc.fields.find((f) => f.name === 'brand')!;
    expect(brandField.stats.fillRate).toBeCloseTo(2 / 3);
  });

  it('computes uniqueCount correctly', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const brandField = doc.fields.find((f) => f.name === 'brand')!;
    expect(brandField.stats.uniqueCount).toBe(1); // only 'Acme' (null excluded)
  });

  it('computes min/max for numeric fields', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const priceField = doc.fields.find((f) => f.name === 'price')!;
    expect(priceField.stats.min).toBe(10);
    expect(priceField.stats.max).toBe(20);
  });

  it('provides sampleValues (up to 5)', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.stats.sampleValues.length).toBeLessThanOrEqual(5);
    expect(nameField.stats.sampleValues).toContain('Widget A');
  });

  it('includes field aliases', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.aliases).toContain('title');
  });

  it('includes field description and type', () => {
    const doc = generateDocumentation(mockSchema, mockEntities, 'j1');
    const nameField = doc.fields.find((f) => f.name === 'name')!;
    expect(nameField.description).toBe('Product name');
    expect(nameField.type).toBe('string');
    expect(nameField.required).toBe(true);
  });

  it('sets sampled flag when entities exceed 1000', () => {
    const largeEntities = Array.from({ length: 1500 }, (_, i) => ({
      id: `e${i}`, jobId: 'j1', mergedData: { name: `Item ${i}` },
      categories: [], qualityScore: 0.5, createdAt: '', sourceCount: 1,
    })) as any;
    const doc = generateDocumentation(mockSchema, largeEntities, 'j1');
    expect(doc.sampled).toBe(true);
    expect(doc.sampleSize).toBe(1000);
  });

  it('handles empty entity list', () => {
    const doc = generateDocumentation(mockSchema, [], 'j1');
    expect(doc.entityCount).toBe(0);
    expect(doc.fields[0].stats.fillRate).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/documentation-generator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DocumentationGenerator**

```typescript
// packages/core/src/exporters/documentation-generator.ts
import type { SchemaDefinition } from '../types/schema.js';
import type { Entity } from '@spatula/shared';
import type { DataDictionary, FieldDocumentation, FieldStats } from './types.js';

const MAX_SAMPLE_ENTITIES = 1000;
const MAX_UNIQUE_TRACK = 1000;
const MAX_SAMPLE_VALUES = 5;

export function generateDocumentation(
  schema: SchemaDefinition,
  entities: Entity[],
  jobId: string,
): DataDictionary {
  const sampled = entities.length > MAX_SAMPLE_ENTITIES;
  const sampleEntities = sampled ? entities.slice(0, MAX_SAMPLE_ENTITIES) : entities;
  const totalCount = sampleEntities.length;

  // Build alias lookup
  const aliasMap = new Map<string, string[]>();
  for (const alias of schema.fieldAliases) {
    aliasMap.set(
      alias.canonicalName,
      alias.aliases.map((a) => a.name),
    );
  }

  const fields: FieldDocumentation[] = schema.fields.map((field) => {
    const stats = computeFieldStats(field.name, field.type, sampleEntities, totalCount);

    return {
      name: field.name,
      type: field.type,
      description: field.description,
      required: field.required,
      aliases: aliasMap.get(field.name) ?? [],
      stats,
    };
  });

  return {
    jobId,
    schemaVersion: schema.version,
    generatedAt: new Date().toISOString(),
    entityCount: entities.length,
    ...(sampled ? { sampled: true, sampleSize: MAX_SAMPLE_ENTITIES } : {}),
    fields,
  };
}

function computeFieldStats(
  fieldName: string,
  fieldType: string,
  entities: Entity[],
  totalCount: number,
): FieldStats {
  let nonNullCount = 0;
  const uniqueValues = new Set<string>();
  const sampleValues: unknown[] = [];
  let min: number | undefined;
  let max: number | undefined;
  const isNumeric = fieldType === 'number' || fieldType === 'currency';

  for (const entity of entities) {
    const val = entity.mergedData[fieldName];
    if (val === null || val === undefined) continue;

    nonNullCount++;

    // Track unique values (string representation, capped)
    const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (uniqueValues.size < MAX_UNIQUE_TRACK) {
      uniqueValues.add(strVal);
    }

    // Collect sample values
    if (sampleValues.length < MAX_SAMPLE_VALUES && !sampleValues.includes(val)) {
      sampleValues.push(val);
    }

    // Min/max for numeric fields
    if (isNumeric && typeof val === 'number') {
      if (min === undefined || val < min) min = val;
      if (max === undefined || val > max) max = val;
    }
  }

  return {
    fillRate: totalCount === 0 ? 0 : nonNullCount / totalCount,
    uniqueCount: uniqueValues.size,
    sampleValues,
    ...(isNumeric && min !== undefined ? { min, max } : {}),
  };
}
```

- [ ] **Step 4: Add to barrel export**

In `packages/core/src/exporters/index.ts`, add:
```typescript
export { generateDocumentation } from './documentation-generator.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/documentation-generator.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/exporters/ packages/core/tests/unit/exporters/
git commit -m "feat(core): add DocumentationGenerator for data dictionary"
```

---

### Task 4: CsvExporter

**Files:**
- Create: `packages/core/src/exporters/csv-exporter.ts`
- Create: `packages/core/tests/unit/exporters/csv-exporter.test.ts`
- Modify: `packages/core/src/exporters/index.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/core/tests/unit/exporters/csv-exporter.test.ts
import { describe, it, expect } from 'vitest';
import { CsvExporter } from '../../../src/exporters/csv-exporter.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const schema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'number', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const entities = [
  { mergedData: { name: 'Product A', price: 10 } },
  { mergedData: { name: 'Product B', price: 20 } },
];

describe('CsvExporter', () => {
  it('has format csv', () => {
    const exporter = new CsvExporter();
    expect(exporter.format).toBe('csv');
  });

  it('exports entities as CSV', async () => {
    const exporter = new CsvExporter();
    const result = await exporter.export(entities, schema, {
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    expect(result.entityCount).toBe(2);
    expect(result.format).toBe('csv');
    const csv = result.data as string;
    const lines = csv.split('\n');
    expect(lines[0]).toBe('name,price');
    expect(lines).toHaveLength(3);
  });

  it('uses schema field order for columns', async () => {
    const exporter = new CsvExporter();
    const result = await exporter.export(entities, schema, {
      format: 'csv',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const csv = result.data as string;
    expect(csv.startsWith('name,price')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/csv-exporter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement CsvExporter**

```typescript
// packages/core/src/exporters/csv-exporter.ts
import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { Entity } from '@spatula/shared';
import { entitiesToCsv } from './csv-utils.js';

export class CsvExporter implements Exporter {
  readonly format = 'csv' as const;

  async export(
    entities: unknown[],
    schema: SchemaDefinition,
    _options: ExportOptions,
  ): Promise<ExportResult> {
    const fields = schema.fields.map((f) => f.name);
    const csv = entitiesToCsv(entities as Entity[], fields);

    return {
      format: 'csv',
      entityCount: entities.length,
      data: csv,
      generatedAt: new Date(),
    };
  }
}
```

- [ ] **Step 4: Add to barrel export and run tests**

Add to `packages/core/src/exporters/index.ts`:
```typescript
export { CsvExporter } from './csv-exporter.js';
```

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/csv-exporter.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/exporters/ packages/core/tests/unit/exporters/
git commit -m "feat(core): add CsvExporter implementing Exporter interface"
```

---

### Task 5: JsonExporter

**Files:**
- Create: `packages/core/src/exporters/json-exporter.ts`
- Create: `packages/core/tests/unit/exporters/json-exporter.test.ts`
- Modify: `packages/core/src/exporters/index.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/core/tests/unit/exporters/json-exporter.test.ts
import { describe, it, expect } from 'vitest';
import { JsonExporter } from '../../../src/exporters/json-exporter.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const schema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'name', description: 'Name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'number', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const entities = [
  { mergedData: { name: 'A', price: 10 }, qualityScore: 0.9, categories: ['test'], sourceCount: 2 },
];

describe('JsonExporter', () => {
  it('has format json', () => {
    const exporter = new JsonExporter();
    expect(exporter.format).toBe('json');
  });

  it('exports entities as JSON array', async () => {
    const exporter = new JsonExporter();
    const result = await exporter.export(entities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    expect(result.entityCount).toBe(1);
    expect(result.format).toBe('json');
    const parsed = JSON.parse(result.data as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].data.name).toBe('A');
    expect(parsed[0].qualityScore).toBe(0.9);
  });

  it('includes provenance when requested', async () => {
    const entitiesWithProv = [
      {
        mergedData: { name: 'A' },
        qualityScore: 0.9,
        categories: [],
        sourceCount: 1,
        provenance: { name: { provenanceType: 'extracted' } },
        sources: [{ extractionId: 'ext-1', matchConfidence: 0.9 }],
      },
    ];
    const exporter = new JsonExporter();
    const result = await exporter.export(entitiesWithProv, schema, {
      format: 'json',
      includeProvenance: true,
      includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].provenance).toBeDefined();
    expect(parsed[0].sources).toBeDefined();
  });

  it('excludes provenance by default', async () => {
    const exporter = new JsonExporter();
    const result = await exporter.export(entities, schema, {
      format: 'json',
      includeProvenance: false,
      includeDocumentation: false,
    });
    const parsed = JSON.parse(result.data as string);
    expect(parsed[0].provenance).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/json-exporter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement JsonExporter**

The JsonExporter serializes entities. The worker wraps the output with the metadata/schema/documentation envelope.

```typescript
// packages/core/src/exporters/json-exporter.ts
import type { Exporter, ExportOptions, ExportResult } from '../interfaces/exporter.js';
import type { SchemaDefinition } from '../types/schema.js';

interface EntityLike {
  mergedData: Record<string, unknown>;
  qualityScore?: number;
  categories?: string[];
  sourceCount?: number;
  provenance?: Record<string, unknown>;
  sources?: unknown[];
}

export class JsonExporter implements Exporter {
  readonly format = 'json' as const;

  async export(
    entities: unknown[],
    _schema: SchemaDefinition,
    options: ExportOptions,
  ): Promise<ExportResult> {
    const serialized = (entities as EntityLike[]).map((entity) => {
      const base: Record<string, unknown> = {
        data: entity.mergedData,
        qualityScore: entity.qualityScore,
        categories: entity.categories,
        sourceCount: entity.sourceCount,
      };

      if (options.includeProvenance && entity.provenance) {
        base.provenance = entity.provenance;
        base.sources = entity.sources;
      }

      return base;
    });

    const json = JSON.stringify(serialized, null, 2);

    return {
      format: 'json',
      entityCount: entities.length,
      data: json,
      generatedAt: new Date(),
    };
  }
}
```

- [ ] **Step 4: Add to barrel export and run tests**

Add to `packages/core/src/exporters/index.ts`:
```typescript
export { JsonExporter } from './json-exporter.js';
```

Run: `cd packages/core && pnpm test -- --run tests/unit/exporters/json-exporter.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/exporters/ packages/core/tests/unit/exporters/
git commit -m "feat(core): add JsonExporter implementing Exporter interface"
```

---

## Chunk 2: Database & Queue Infrastructure

### Task 6: Exports table and ExportRepository

**Files:**
- Create: `packages/db/src/schema/exports.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/repositories/export-repository.ts`
- Modify: `packages/db/src/repositories/index.ts`
- Create: `packages/db/tests/unit/repositories/export-repository.test.ts`

- [ ] **Step 1: Create exports table schema**

```typescript
// packages/db/src/schema/exports.ts
import { pgTable, uuid, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const exports = pgTable(
  'exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    format: text('format').notNull(),
    status: text('status').notNull().default('pending'),
    includeProvenance: boolean('include_provenance').notNull().default(false),
    entityCount: integer('entity_count'),
    contentRef: text('content_ref'),
    fileSize: integer('file_size'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('exports_job_idx').on(table.jobId),
    index('exports_tenant_idx').on(table.tenantId),
  ],
);
```

Add to `packages/db/src/schema/index.ts`:
```typescript
export * from './exports.js';
```

- [ ] **Step 2: Write failing tests for ExportRepository**

```typescript
// packages/db/tests/unit/repositories/export-repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExportRepository } from '../../../src/repositories/export-repository.js';

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'export-id', status: 'pending' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'export-id', status: 'pending' }]));

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'export-id', status: 'pending' }]) }),
    }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('ExportRepository', () => {
  let repo: ExportRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ExportRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findById method', () => {
    expect(typeof repo.findById).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      format: 'json',
      includeProvenance: false,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('findById calls db.select', async () => {
    await repo.findById('export-id', 'tenant-id');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('updateStatus calls db.update', async () => {
    await repo.updateStatus('export-id', 'tenant-id', {
      status: 'completed',
      entityCount: 42,
      contentRef: 'pg://abc',
      fileSize: 1024,
      completedAt: new Date(),
    });
    expect(mockDb.update).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/db && pnpm test -- --run tests/unit/repositories/export-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement ExportRepository**

```typescript
// packages/db/src/repositories/export-repository.ts
import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { exports } from '../schema/exports.js';
import type { Database } from '../connection.js';

const logger = createLogger('export-repository');

export interface CreateExportInput {
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv';
  includeProvenance: boolean;
}

export class ExportRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateExportInput) {
    try {
      const [row] = await this.db
        .insert(exports)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          format: input.format,
          includeProvenance: input.includeProvenance,
        })
        .returning();
      logger.debug({ exportId: row.id }, 'export created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create export: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId },
      });
    }
  }

  async findById(exportId: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(exports)
        .where(and(eq(exports.id, exportId), eq(exports.tenantId, tenantId)));
      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find export: ${(error as Error).message}`, {
        cause: error as Error,
        context: { exportId },
      });
    }
  }

  async findByJob(jobId: string, tenantId: string) {
    try {
      return await this.db
        .select()
        .from(exports)
        .where(and(eq(exports.jobId, jobId), eq(exports.tenantId, tenantId)))
        .orderBy(desc(exports.createdAt));
    } catch (error) {
      throw new StorageError(`Failed to find exports: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async updateStatus(
    exportId: string,
    tenantId: string,
    update: {
      status: 'processing' | 'completed' | 'failed';
      entityCount?: number;
      contentRef?: string;
      fileSize?: number;
      error?: string;
      completedAt?: Date;
    },
  ) {
    try {
      const [row] = await this.db
        .update(exports)
        .set(update)
        .where(and(eq(exports.id, exportId), eq(exports.tenantId, tenantId)))
        .returning();
      if (!row) {
        throw new StorageError(`Export ${exportId} not found`, { context: { exportId } });
      }
      logger.debug({ exportId, status: update.status }, 'export status updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update export: ${(error as Error).message}`, {
        cause: error as Error,
        context: { exportId },
      });
    }
  }
}
```

- [ ] **Step 5: Add to repository index**

In `packages/db/src/repositories/index.ts`, add:
```typescript
export { ExportRepository } from './export-repository.js';
export type { CreateExportInput } from './export-repository.js';
```

- [ ] **Step 6: Run tests**

Run: `cd packages/db && pnpm test -- --run tests/unit/repositories/export-repository.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/exports.ts packages/db/src/schema/index.ts packages/db/src/repositories/export-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/export-repository.test.ts
git commit -m "feat(db): add exports table and ExportRepository"
```

---

### Task 7: Queue additions (ExportJobPayload, QUEUE_NAMES, SpatulaQueues)

**Files:**
- Modify: `packages/queue/src/queues.ts`
- Modify: `packages/queue/src/worker-deps.ts`
- Modify: `packages/queue/src/index.ts`

- [ ] **Step 1: Add ExportJobPayload and queue to queues.ts**

In `packages/queue/src/queues.ts`:

Add to `QUEUE_NAMES` (after RECONCILIATION):
```typescript
EXPORT: 'spatula:export',
```

Add interface (after ReconciliationJobData):
```typescript
export interface ExportJobPayload {
  exportId: string;
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv';
  includeProvenance: boolean;
}
```

Add to `SpatulaQueues` interface:
```typescript
export: Queue<ExportJobPayload>;
```

Update `createQueues` to create the export queue and include it in `closeAll`.

- [ ] **Step 2: Add exportRepo to WorkerDeps**

In `packages/queue/src/worker-deps.ts`:

Add import:
```typescript
import type { ExportRepository } from '@spatula/db';
```

Add to `WorkerDepsConfig`:
```typescript
exportRepo: ExportRepository;
```

Add to `WorkerDeps` class (readonly field + constructor assignment).

- [ ] **Step 3: Export new types from index**

Ensure `ExportJobPayload` is exported from `packages/queue/src/index.ts`.

- [ ] **Step 4: Run queue tests**

Run: `cd packages/queue && pnpm test`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/queues.ts packages/queue/src/worker-deps.ts packages/queue/src/index.ts
git commit -m "feat(queue): add export queue and ExportJobPayload"
```

---

### Task 8: ExportWorker

**Files:**
- Create: `packages/queue/src/workers/export-worker.ts`
- Create: `packages/queue/tests/unit/workers/export-worker.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/queue/tests/unit/workers/export-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processExportJob } from '../../../src/workers/export-worker.js';
import type { ExportJobPayload } from '../../../src/queues.js';
import type { WorkerDeps } from '../../../src/worker-deps.js';

function createMockDeps(): WorkerDeps {
  return {
    exportRepo: {
      updateStatus: vi.fn().mockResolvedValue({ id: 'exp-1', status: 'completed' }),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        definition: {
          version: 1,
          fields: [{ name: 'name', description: 'Name', type: 'string', required: true }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue('pg://ref-1'),
    },
  } as unknown as WorkerDeps;
}

const payload: ExportJobPayload = {
  exportId: 'exp-1',
  jobId: 'job-1',
  tenantId: 'tenant-1',
  format: 'json',
  includeProvenance: false,
};

describe('processExportJob', () => {
  it('updates status to processing then completed', async () => {
    const deps = createMockDeps();
    await processExportJob(payload, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'processing' }),
    );
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('stores content in content store', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);

    await processExportJob(payload, deps);
    expect(deps.contentStore.store).toHaveBeenCalled();
  });

  it('sets status to failed on error', async () => {
    const deps = createMockDeps();
    (deps.schemaRepo.findLatest as any).mockRejectedValue(new Error('db error'));

    await processExportJob(payload, deps);
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'failed', error: expect.any(String) }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/queue && pnpm test -- --run tests/unit/workers/export-worker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement ExportWorker**

```typescript
// packages/queue/src/workers/export-worker.ts
import { createLogger } from '@spatula/shared';
import { CsvExporter, JsonExporter, generateDocumentation } from '@spatula/core';
import type { SchemaDefinition } from '@spatula/core';
import type { Entity } from '@spatula/shared';
import type { ExportJobPayload } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('export-worker');

export async function processExportJob(
  data: ExportJobPayload,
  deps: WorkerDeps,
): Promise<void> {
  const { exportId, jobId, tenantId, format, includeProvenance } = data;

  try {
    // 1. Mark as processing
    await deps.exportRepo.updateStatus(exportId, tenantId, { status: 'processing' });

    // 2. Fetch schema
    const schemaRow = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schemaRow) {
      throw new Error('No schema found for job');
    }
    const schema = schemaRow.definition as SchemaDefinition;

    // 3. Fetch all entities in batches
    // Note: findByJob excludes provenance column for efficiency.
    // For JSON exports with includeProvenance: true, a findByJobWithProvenance
    // method would be needed. Deferred to follow-up — v1 exports exclude provenance
    // from entity data (provenance is still captured in the overall export metadata).
    const allEntities: Entity[] = [];
    const total = await deps.entityRepo.countByJob(jobId, tenantId);
    let offset = 0;
    while (offset < total) {
      const batch = await deps.entityRepo.findByJob(jobId, tenantId, {
        limit: 100,
        offset,
      });
      allEntities.push(...(batch as unknown as Entity[]));
      offset += 100;
    }

    // 4. Generate documentation (for JSON)
    const documentation = format === 'json'
      ? generateDocumentation(schema, allEntities, jobId)
      : null;

    // 5. Run exporter
    const exporter = format === 'csv' ? new CsvExporter() : new JsonExporter();
    const result = await exporter.export(allEntities, schema, {
      format,
      includeProvenance,
      includeDocumentation: format === 'json',
    });

    // 6. For JSON, wrap with envelope (metadata + schema + docs + entities)
    let content: string;
    if (format === 'json') {
      const envelope = {
        metadata: {
          jobId,
          exportedAt: new Date().toISOString(),
          entityCount: allEntities.length,
          schemaVersion: schema.version,
          format: 'json',
          includeProvenance,
        },
        schema,
        documentation,
        entities: JSON.parse(result.data as string),
      };
      content = JSON.stringify(envelope, null, 2);
    } else {
      content = result.data as string;
    }

    // 7. Store in content store
    const key = `exports/${tenantId}/${jobId}/${exportId}.${format}`;
    const contentRef = await deps.contentStore.store(key, content);

    // 8. Mark as completed
    await deps.exportRepo.updateStatus(exportId, tenantId, {
      status: 'completed',
      entityCount: allEntities.length,
      contentRef,
      fileSize: Buffer.byteLength(content, 'utf-8'),
      completedAt: new Date(),
    });

    logger.info({ exportId, jobId, format, entityCount: allEntities.length }, 'export completed');
  } catch (error) {
    logger.error({ exportId, jobId, error }, 'export job failed');
    await deps.exportRepo.updateStatus(exportId, tenantId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }).catch((e: unknown) => {
      logger.error({ exportId, error: e }, 'failed to mark export as failed');
    });
  }
}
```

- [ ] **Step 4: Export processExportJob from queue index**

In `packages/queue/src/index.ts`, add:
```typescript
export { processExportJob } from './workers/export-worker.js';
```

This follows the existing pattern where all worker processors are exported from the queue package index.

- [ ] **Step 5: Run tests**

Run: `cd packages/queue && pnpm test -- --run tests/unit/workers/export-worker.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/workers/export-worker.ts packages/queue/src/index.ts packages/queue/tests/unit/workers/export-worker.test.ts
git commit -m "feat(queue): add ExportWorker for async export generation"
```

---

## Chunk 3: API Endpoints & CLI Integration

### Task 9: Export request schema + AppDeps update

**Files:**
- Create: `apps/api/src/schemas/export-request.ts`
- Modify: `apps/api/src/types.ts`

- [ ] **Step 1: Create export request schema**

```typescript
// apps/api/src/schemas/export-request.ts
import { z } from 'zod';

export const exportRequestSchema = z.object({
  format: z.enum(['json', 'csv']),
  includeProvenance: z.boolean().default(false),
});

export type ExportRequestParams = z.infer<typeof exportRequestSchema>;
```

- [ ] **Step 2: Update AppDeps**

In `apps/api/src/types.ts`, add imports and new fields:

```typescript
import type { ExportRepository } from '@spatula/db';
import type { ContentStore } from '@spatula/core';
import type { Queue } from 'bullmq';
import type { ExportJobPayload } from '@spatula/queue';
```

Add to `AppDeps`:
```typescript
exportRepo: ExportRepository;
contentStore: ContentStore;
exportQueue: Queue<ExportJobPayload>;
```

- [ ] **Step 3: Update app.test.ts mock deps**

In `apps/api/tests/unit/app.test.ts`, add to the `createMockDeps()` function:
```typescript
exportRepo: { create: vi.fn(), findById: vi.fn(), findByJob: vi.fn(), updateStatus: vi.fn() },
contentStore: { store: vi.fn(), retrieve: vi.fn(), delete: vi.fn() },
exportQueue: { add: vi.fn() },
```

This prevents the test from breaking due to the expanded `AppDeps` type.

- [ ] **Step 4: Run API tests to verify no regressions**

Run: `cd apps/api && pnpm test`
Expected: All PASS (existing tests still work with the expanded type).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas/export-request.ts apps/api/src/types.ts apps/api/tests/unit/app.test.ts
git commit -m "feat(api): add export request schema and update AppDeps"
```

---

### Task 10: Export API routes (replace stubs)

**Files:**
- Modify: `apps/api/src/routes/exports.ts`
- Modify: `apps/api/tests/unit/routes/exports.test.ts`

- [ ] **Step 1: Write new tests**

Replace the existing stub tests in `apps/api/tests/unit/routes/exports.test.ts` with real tests:

```typescript
// apps/api/tests/unit/routes/exports.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { exportRoutes } from '../../../src/routes/exports.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

const TENANT_ID = 'tenant-1';

function createMockDeps(): AppDeps {
  return {
    exportRepo: {
      create: vi.fn().mockResolvedValue({
        id: 'exp-1', status: 'pending', format: 'json',
        includeProvenance: false, createdAt: new Date().toISOString(),
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'exp-1', status: 'completed', format: 'json',
        includeProvenance: false, entityCount: 42, fileSize: 1024,
        contentRef: 'pg://ref-1', createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
      findByJob: vi.fn().mockResolvedValue([]),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        definition: {
          version: 1,
          fields: [{ name: 'name', description: 'Name', type: 'string', required: true }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
    },
    contentStore: {
      retrieve: vi.fn().mockResolvedValue('{"entities":[]}'),
    },
    exportQueue: {
      add: vi.fn().mockResolvedValue({ id: 'bull-job-1' }),
    },
    // other deps not needed for export routes
    jobRepo: {} as any,
    extractionRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {} as any,
  } as unknown as AppDeps;
}

function createTestApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', TENANT_ID);
    return next();
  });
  app.route('/api/v1/jobs/:jobId', exportRoutes());
  return app;
}

describe('Export routes', () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe('POST /export', () => {
    it('creates export and returns 202', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'json' }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.data.id).toBe('exp-1');
      expect(body.data.status).toBe('pending');
    });

    it('enqueues BullMQ job', async () => {
      await app.request('/api/v1/jobs/job-1/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv' }),
      });
      expect(deps.exportQueue.add).toHaveBeenCalled();
    });

    it('returns 400 for invalid format', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'parquet' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /export/:exportId', () => {
    it('returns export status', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export/exp-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('completed');
      expect(body.data.entityCount).toBe(42);
    });

    it('returns 404 for missing export', async () => {
      (deps.exportRepo.findById as any).mockResolvedValueOnce(null);
      const res = await app.request('/api/v1/jobs/job-1/export/missing');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /export/:exportId/download', () => {
    it('returns file content', async () => {
      const res = await app.request('/api/v1/jobs/job-1/export/exp-1/download');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('returns 409 when export not completed', async () => {
      (deps.exportRepo.findById as any).mockResolvedValueOnce({ id: 'exp-1', status: 'processing' });
      const res = await app.request('/api/v1/jobs/job-1/export/exp-1/download');
      expect(res.status).toBe(409);
    });
  });

  describe('GET /documentation', () => {
    it('returns data dictionary', async () => {
      const res = await app.request('/api/v1/jobs/job-1/documentation');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.fields).toBeDefined();
      expect(body.data.schemaVersion).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/exports.test.ts`
Expected: FAIL — routes still return 501.

- [ ] **Step 3: Implement export routes**

Replace the entire `apps/api/src/routes/exports.ts`:

```typescript
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { exportRequestSchema } from '../schemas/export-request.js';
import { validateBody } from '../middleware/validate.js';
import { NotFoundError, ConflictError } from '../middleware/error-handler.js';
import { generateDocumentation } from '@spatula/core';
import type { SchemaDefinition } from '@spatula/core';
import type { Entity } from '@spatula/shared';

export function exportRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST /export — trigger export
  router.post('/export', validateBody(exportRequestSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const body = c.get('validatedBody') as { format: 'json' | 'csv'; includeProvenance: boolean };

    const exportRecord = await deps.exportRepo.create({
      jobId,
      tenantId,
      format: body.format,
      includeProvenance: body.includeProvenance,
    });

    await deps.exportQueue.add('export', {
      exportId: exportRecord.id,
      jobId,
      tenantId,
      format: body.format,
      includeProvenance: body.includeProvenance,
    });

    return c.json({ data: exportRecord }, 202);
  });

  // GET /export/:exportId — check status
  router.get('/export/:exportId', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const exportId = c.req.param('exportId');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) {
      throw new NotFoundError('Export', exportId);
    }

    return c.json({ data: exportRecord });
  });

  // GET /export/:exportId/download — download file
  router.get('/export/:exportId/download', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const exportId = c.req.param('exportId');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) {
      throw new NotFoundError('Export', exportId);
    }

    if (exportRecord.status !== 'completed' || !exportRecord.contentRef) {
      throw new ConflictError('Export is not yet completed');
    }

    const content = await deps.contentStore.retrieve(exportRecord.contentRef);
    const contentType = exportRecord.format === 'csv' ? 'text/csv' : 'application/json';
    const jobShort = exportRecord.jobId.slice(0, 8);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `spatula-${jobShort}-${date}.${exportRecord.format}`;

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        ...(exportRecord.fileSize ? { 'Content-Length': String(exportRecord.fileSize) } : {}),
      },
    });
  });

  // GET /documentation — data dictionary
  router.get('/documentation', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;

    const schemaRow = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schemaRow) {
      throw new NotFoundError('Schema', jobId);
    }
    const schema = schemaRow.definition as SchemaDefinition;

    // Fetch entities (sample for large datasets) and true total
    const [entities, totalCount] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, { limit: 1000 }),
      deps.entityRepo.countByJob(jobId, tenantId),
    ]);

    const documentation = generateDocumentation(schema, entities as unknown as Entity[], jobId);
    // Fix entity count to reflect true total (not sample size)
    documentation.entityCount = totalCount;

    return c.json({ data: documentation });
  });

  return router;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && pnpm test -- --run tests/unit/routes/exports.test.ts`
Expected: All PASS.

- [ ] **Step 5: Update app.test.ts mocks if needed**

Check `apps/api/tests/unit/app.test.ts` — add `exportRepo`, `contentStore`, `exportQueue` to its mock deps if not already present.

- [ ] **Step 6: Run full API tests**

Run: `cd apps/api && pnpm test`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/exports.ts apps/api/src/schemas/export-request.ts apps/api/tests/unit/routes/exports.test.ts
git commit -m "feat(api): implement export endpoints replacing 501 stubs"
```

---

### Task 11: API client export methods

**Files:**
- Modify: `apps/cli/src/api/client.ts`
- Modify: `apps/cli/tests/unit/api/client.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `apps/cli/tests/unit/api/client.test.ts`:

```typescript
describe('createExport', () => {
  it('sends POST to /export', async () => {
    mockFetchOk({ id: 'exp-1', status: 'pending' });
    const result = await client.createExport('job-1', { format: 'json' });
    expect(result.id).toBe('exp-1');
    const { url, init } = lastFetchCall();
    expect(url).toContain('/jobs/job-1/export');
    expect(init.method).toBe('POST');
  });
});

describe('getExport', () => {
  it('fetches export status', async () => {
    mockFetchOk({ id: 'exp-1', status: 'completed' });
    const result = await client.getExport('job-1', 'exp-1');
    expect(result.status).toBe('completed');
  });
});

describe('downloadExport', () => {
  it('returns raw content as string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('name,price\nA,10'),
    }));
    const content = await client.downloadExport('job-1', 'exp-1');
    expect(content).toBe('name,price\nA,10');
  });
});

describe('getDocumentation', () => {
  it('fetches documentation', async () => {
    mockFetchOk({ fields: [], schemaVersion: 1 });
    const result = await client.getDocumentation('job-1');
    expect(result.schemaVersion).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm test -- --run tests/unit/api/client.test.ts`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add methods to SpatulaApiClient**

In `apps/cli/src/api/client.ts`, add after the entities section:

```typescript
// -----------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------

async createExport(
  jobId: string,
  body: { format: string; includeProvenance?: boolean },
): Promise<Record<string, unknown>> {
  return this.post(`/api/v1/jobs/${jobId}/export`, body);
}

async getExport(
  jobId: string,
  exportId: string,
): Promise<Record<string, unknown>> {
  return this.get(`/api/v1/jobs/${jobId}/export/${exportId}`);
}

async downloadExport(
  jobId: string,
  exportId: string,
): Promise<string> {
  const url = this.buildUrl(`/api/v1/jobs/${jobId}/export/${exportId}/download`);

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers: this.headers() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown network error';
    throw new ApiError(0, 'NETWORK_ERROR', message);
  }

  if (!response.ok) {
    let code: string | undefined;
    let message = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as Record<string, unknown>;
      const err = errorBody?.error as Record<string, unknown> | undefined;
      if (err) {
        code = err.code as string | undefined;
        message = (err.message as string) ?? message;
      }
    } catch {
      // not JSON
    }
    throw new ApiError(response.status, code, message);
  }

  return response.text();
}

async getDocumentation(
  jobId: string,
): Promise<Record<string, unknown>> {
  return this.get(`/api/v1/jobs/${jobId}/documentation`);
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/cli && pnpm test -- --run tests/unit/api/client.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/api/client.ts apps/cli/tests/unit/api/client.test.ts
git commit -m "feat(cli): add export API client methods"
```

---

### Task 12: Update CLI useExport to use API pipeline

**Files:**
- Modify: `apps/cli/src/hooks/useExport.ts`
- Modify: `apps/cli/tests/unit/hooks/useExport.test.ts`

- [ ] **Step 1: Update useExport hook**

Replace `exportEntitySet` to use the API pipeline instead of fetching entities locally. Keep `exportSingleEntity` for quick single-entity exports (local is cheaper). The entity set flow becomes:

1. Call `apiClient.createExport(jobId, { format, includeProvenance })`
2. Poll `apiClient.getExport(jobId, exportId)` until status is `completed` or `failed`
3. Call `apiClient.downloadExport(jobId, exportId)` to get content
4. Write to local file

Read the existing `useExport.ts` first and refactor `exportEntitySet` while keeping the `exportSingleEntity` logic (which uses the shared CSV utils from `@spatula/core`).

The `exportProgress` state should track export status (`pending` → `processing` → `completed`) instead of entity fetch progress.

- [ ] **Step 2: Update ExportDialog progress display**

In `apps/cli/src/components/explorer/ExportDialog.tsx`, the progress state from `useExport` changes shape. Previously it was `{ fetched: number; total: number }` for local entity fetching. Now it should display export job status (`Pending...` → `Processing...` → `Completed`). Update the rendering logic that shows progress to reflect the new poll-based flow. The `isExporting` flag still works — it's true while polling, false when done.

- [ ] **Step 3: Update tests**

Update `apps/cli/tests/unit/hooks/useExport.test.ts` — the `entityToCsvRow` tests remain unchanged (CSV utils are now from core but the test file can still import them via re-export). Add a test verifying `useExport` is exported.

- [ ] **Step 4: Run tests**

Run: `cd apps/cli && pnpm test`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/hooks/useExport.ts apps/cli/src/components/explorer/ExportDialog.tsx apps/cli/tests/unit/hooks/useExport.test.ts
git commit -m "feat(cli): update useExport and ExportDialog to use API export pipeline"
```

---

### Task 13: Final integration and full test run

**Files:**
- No new files — verify everything works together

- [ ] **Step 1: Run full core tests**

Run: `cd packages/core && pnpm test`
Expected: All PASS.

- [ ] **Step 2: Run full DB tests**

Run: `cd packages/db && pnpm test`
Expected: All PASS.

- [ ] **Step 3: Run full queue tests**

Run: `cd packages/queue && pnpm test`
Expected: All PASS.

- [ ] **Step 4: Run full API tests**

Run: `cd apps/api && pnpm test`
Expected: All PASS.

- [ ] **Step 5: Run full CLI tests**

Run: `cd apps/cli && pnpm test`
Expected: All PASS.

- [ ] **Step 6: Run full monorepo build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 7: Run full monorepo tests**

Run: `pnpm test`
Expected: All PASS.

- [ ] **Step 8: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve integration issues from Phase 10"
```
