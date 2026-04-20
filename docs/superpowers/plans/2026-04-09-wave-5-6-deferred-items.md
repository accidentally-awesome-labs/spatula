# Wave 5-6: Deferred Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address 10 deferred items from Waves 2-5: security fixes, observability, pull command enhancements, CSS table extraction, crawl history dedup, and config diff recursion.

**Architecture:** Three independent groups. Group 3 (tech debt) and Group 2 (local extraction) are fully independent. Group 1 (remote/platform) has internal dependencies: SQLite migration must precede repo methods, which must precede pull flow extension. Server-side changes (API endpoints) must precede client methods.

**Tech Stack:** TypeScript, Drizzle ORM, SQLite (better-sqlite3), Hono, Cheerio, Vitest, pnpm monorepo

**Spec:** `docs/superpowers/specs/2026-04-09-wave-5-6-deferred-items-design.md`

---

## Task 1: Config Diff Recursive Comparison

**Files:**
- Modify: `packages/core/src/config/diff-types.ts:7-14`
- Modify: `packages/core/src/config/config-differ.ts:174-198`
- Test: `packages/core/tests/unit/config/config-differ.test.ts`

- [x] **Step 1: Write failing tests for nested field diff**

In `packages/core/tests/unit/config/config-differ.test.ts`, add tests:

```typescript
describe('diffConfigs nested fields', () => {
  it('detects arrayItemType changes', () => {
    const prev = makeConfig({
      fields: [{ name: 'tags', description: 'Tags', type: 'array', arrayItemType: { name: 'item', description: 'tag', type: 'string', required: false } }],
    });
    const curr = makeConfig({
      fields: [{ name: 'tags', description: 'Tags', type: 'array', arrayItemType: { name: 'item', description: 'tag', type: 'number', required: false } }],
    });
    const diff = diffConfigs(curr, prev);
    expect(diff.fieldsModified).toHaveLength(1);
    const tagChanges = diff.fieldsModified[0].changes;
    const arrayChange = tagChanges.find(c => c.property === 'arrayItemType');
    expect(arrayChange).toBeDefined();
    expect(arrayChange!.nestedChanges).toBeDefined();
    expect(arrayChange!.nestedChanges).toContainEqual(
      expect.objectContaining({ property: 'type', from: 'string', to: 'number' }),
    );
  });

  it('detects objectFields added/removed/modified', () => {
    const prev = makeConfig({
      fields: [{
        name: 'address', description: 'Address', type: 'object',
        objectFields: [
          { name: 'street', description: 'Street', type: 'string', required: true },
          { name: 'zip', description: 'Zip', type: 'string', required: false },
        ],
      }],
    });
    const curr = makeConfig({
      fields: [{
        name: 'address', description: 'Address', type: 'object',
        objectFields: [
          { name: 'street', description: 'Street', type: 'string', required: false }, // changed
          { name: 'city', description: 'City', type: 'string', required: true },      // added
          // zip removed
        ],
      }],
    });
    const diff = diffConfigs(curr, prev);
    expect(diff.fieldsModified).toHaveLength(1);
    const objChange = diff.fieldsModified[0].changes.find(c => c.property === 'objectFields');
    expect(objChange).toBeDefined();
    expect(objChange!.addedFields).toContain('city');
    expect(objChange!.removedFields).toContain('zip');
    expect(objChange!.nestedChanges).toContainEqual(
      expect.objectContaining({ property: 'required', from: true, to: false }),
    );
  });

  it('ignores unchanged nested fields', () => {
    const config = makeConfig({
      fields: [{ name: 'tags', description: 'Tags', type: 'array', arrayItemType: { name: 'item', description: 'tag', type: 'string', required: false } }],
    });
    const diff = diffConfigs(config, config);
    expect(diff.hasChanges).toBe(false);
  });
});
```

Note: `makeConfig` is a helper that wraps fields in a full `JobConfig`. Check if it exists in the test file; if not, create a minimal one that constructs a valid `JobConfig` with the given fields.

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm test -- --run config-differ`
Expected: FAIL — `nestedChanges` and `addedFields` don't exist on change entries

- [x] **Step 3: Extend PropertyChange type in diff-types.ts**

In `packages/core/src/config/diff-types.ts`, replace the inline type with a named interface:

```typescript
export interface PropertyChange {
  property: string;
  from: unknown;
  to: unknown;
  nestedChanges?: PropertyChange[];
  addedFields?: string[];
  removedFields?: string[];
}

export interface FieldChange {
  name: string;
  changes: PropertyChange[];
}
```

- [x] **Step 4: Add recursive comparison to diffFieldProperties**

In `packages/core/src/config/config-differ.ts`, after line 195 (the TODO comment), add:

```typescript
  // Recursive: arrayItemType
  if (current.arrayItemType && previous.arrayItemType) {
    const nested = diffFieldProperties(current.arrayItemType, previous.arrayItemType);
    if (nested.length > 0) {
      changes.push({ property: 'arrayItemType', from: previous.arrayItemType, to: current.arrayItemType, nestedChanges: nested });
    }
  } else if (current.arrayItemType !== previous.arrayItemType) {
    changes.push({ property: 'arrayItemType', from: previous.arrayItemType, to: current.arrayItemType });
  }

  // Recursive: objectFields
  if (current.objectFields || previous.objectFields) {
    const currMap = new Map((current.objectFields ?? []).map(f => [f.name, f]));
    const prevMap = new Map((previous.objectFields ?? []).map(f => [f.name, f]));

    const addedFields = [...currMap.keys()].filter(k => !prevMap.has(k));
    const removedFields = [...prevMap.keys()].filter(k => !currMap.has(k));
    const nestedChanges = [...currMap.keys()]
      .filter(k => prevMap.has(k))
      .flatMap(k => diffFieldProperties(currMap.get(k)!, prevMap.get(k)!));

    if (addedFields.length || removedFields.length || nestedChanges.length) {
      changes.push({
        property: 'objectFields', from: previous.objectFields, to: current.objectFields,
        nestedChanges, addedFields, removedFields,
      });
    }
  }
```

Remove the TODO comment at line 195.

- [x] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm test -- --run config-differ`
Expected: ALL PASS

- [x] **Step 6: Commit**

```bash
git add packages/core/src/config/diff-types.ts packages/core/src/config/config-differ.ts packages/core/tests/unit/config/config-differ.test.ts
git commit -m "feat(core): add recursive objectFields/arrayItemType comparison to config diff"
```

---

## Task 2: CSS Extractor Table Extraction

**Files:**
- Modify: `packages/core/src/extraction/css-extractor.ts:55-63` (extractByField) and add `findTable` function
- Test: `packages/core/tests/unit/extraction/css-extractor.test.ts`

- [x] **Step 1: Write failing tests for table extraction**

In `packages/core/tests/unit/extraction/css-extractor.test.ts`, add:

```typescript
describe('table extraction', () => {
  const extractor = new CssExtractor();
  const tableHtml = `<html><body><article>
    <table class="specs">
      <thead><tr><th>Name</th><th>Price</th><th>Rating</th></tr></thead>
      <tbody>
        <tr><td>Widget A</td><td>$10</td><td>4.5</td></tr>
        <tr><td>Widget B</td><td>$20</td><td>3.8</td></tr>
      </tbody>
    </table>
  </article></body></html>`;

  it('extracts table as array of objects when field is array+object', async () => {
    const schema = {
      version: 1,
      fields: [{
        name: 'specs', description: 'Specs table', type: 'array' as const,
        required: false,
        arrayItemType: { name: 'row', description: 'Row', type: 'object' as const, required: false },
      }],
      fieldAliases: [], createdAt: new Date(), parentVersion: null,
    };
    const result = await extractor.extract(tableHtml, 'https://example.com', schema, '');
    expect(result.data.specs).toEqual([
      { Name: 'Widget A', Price: '$10', Rating: '4.5' },
      { Name: 'Widget B', Price: '$20', Rating: '3.8' },
    ]);
  });

  it('returns null when no table found', async () => {
    const schema = {
      version: 1,
      fields: [{
        name: 'specs', description: 'Specs', type: 'array' as const, required: false,
        arrayItemType: { name: 'row', description: 'Row', type: 'object' as const, required: false },
      }],
      fieldAliases: [], createdAt: new Date(), parentVersion: null,
    };
    const result = await extractor.extract('<html><body><p>No tables</p></body></html>', 'https://example.com', schema, '');
    expect(result.data.specs).toBeUndefined();
  });

  it('generates column headers when thead is missing', async () => {
    const html = `<html><body><table>
      <tr><td>A</td><td>B</td></tr>
      <tr><td>C</td><td>D</td></tr>
    </table></body></html>`;
    const schema = {
      version: 1,
      fields: [{ name: 'data', description: 'Data', type: 'array' as const, required: false,
        arrayItemType: { name: 'row', description: 'Row', type: 'object' as const, required: false } }],
      fieldAliases: [], createdAt: new Date(), parentVersion: null,
    };
    const result = await extractor.extract(html, 'https://example.com', schema, '');
    // First row becomes headers
    expect(result.data.data).toEqual([{ A: 'C', B: 'D' }]);
  });

  it('handles colspan by filling adjacent columns', async () => {
    const html = `<html><body><table>
      <thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
      <tbody><tr><td colspan="2">Wide</td><td>Narrow</td></tr></tbody>
    </table></body></html>`;
    const schema = {
      version: 1,
      fields: [{ name: 'data', description: 'Data', type: 'array' as const, required: false,
        arrayItemType: { name: 'row', description: 'Row', type: 'object' as const, required: false } }],
      fieldAliases: [], createdAt: new Date(), parentVersion: null,
    };
    const result = await extractor.extract(html, 'https://example.com', schema, '');
    expect(result.data.data).toEqual([{ A: 'Wide', B: 'Wide', C: 'Narrow' }]);
  });

  it('includes tables in autoDiscover when 3+ data rows exist', async () => {
    const bigTableHtml = `<html><body><article>
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>2</td></tr>
          <tr><td>3</td><td>4</td></tr>
          <tr><td>5</td><td>6</td></tr>
        </tbody>
      </table>
    </article></body></html>`;
    const schema = { version: 1, fields: [], fieldAliases: [], createdAt: new Date(), parentVersion: null };
    const result = await extractor.extract(bigTableHtml, 'https://example.com', schema, '');
    expect(result.data.tables).toBeDefined();
    expect(result.data.tables).toHaveLength(3);
  });

  it('skips tables in autoDiscover when fewer than 3 data rows', async () => {
    const schema = { version: 1, fields: [], fieldAliases: [], createdAt: new Date(), parentVersion: null };
    const result = await extractor.extract(tableHtml, 'https://example.com', schema, '');
    // tableHtml has only 2 rows, below the 3-row threshold
    expect(result.data.tables).toBeUndefined();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm test -- --run css-extractor`
Expected: FAIL — no table extraction logic exists

- [x] **Step 3: Implement findTable function and wire into extractByField**

In `packages/core/src/extraction/css-extractor.ts`:

Add `findTable` function after `findList`:

```typescript
function findTable($: cheerio.CheerioAPI, fieldName: string): Array<Record<string, string>> | null {
  // Locate table by class/id match or content area fallback
  // Skip class/id selectors when fieldName is empty (autoDiscover mode)
  // because table[class*=""] matches ANY table with a class attribute
  const selectors: string[] = [];
  if (fieldName) {
    selectors.push(`table[class*="${fieldName}"]`, `table[id*="${fieldName}"]`);
  }
  selectors.push('article table', 'main table', '.content table', 'table');

  let table: cheerio.Cheerio<cheerio.Element> | null = null;
  for (const sel of selectors) {
    const found = $(sel).first();
    if (found.length && found.find('tr').length >= 2) {
      table = found;
      break;
    }
  }
  if (!table) return null;

  // Extract headers
  let headers: string[] = [];
  const theadCells = table.find('thead th, thead td');
  if (theadCells.length > 0) {
    headers = theadCells.map((_, el) => $(el).text().trim()).get();
  } else {
    // Use first row as headers
    const firstRow = table.find('tr').first();
    headers = firstRow.find('th, td').map((_, el) => $(el).text().trim()).get();
  }

  if (headers.length === 0) return null;

  // Extract body rows
  const bodyRows = theadCells.length > 0
    ? table.find('tbody tr')
    : table.find('tr').slice(1); // skip header row

  const rows: Array<Record<string, string>> = [];
  bodyRows.each((_, row) => {
    const record: Record<string, string> = {};
    let colIdx = 0;
    $(row).find('th, td').each((_, cell) => {
      const text = $(cell).text().trim();
      const colspan = parseInt($(cell).attr('colspan') ?? '1', 10);
      for (let i = 0; i < colspan && colIdx < headers.length; i++) {
        record[headers[colIdx]] = text;
        colIdx++;
      }
    });
    // Skip entirely empty rows
    if (Object.values(record).some(v => v !== '')) {
      rows.push(record);
    }
  });

  return rows.length > 0 ? rows : null;
}
```

Update `extractByField` to route array+object to table extraction:

```typescript
function extractByField($: cheerio.CheerioAPI, field: FieldDefinition, baseUrl: string): unknown {
  const nameLower = field.name.toLowerCase();
  switch (field.type) {
    case 'currency': return findPrice($);
    case 'url': return findUrl($, nameLower, baseUrl);
    case 'number': return findNumber($, nameLower);
    case 'array':
      if (field.arrayItemType?.type === 'object' || field.objectFields) {
        return findTable($, nameLower);
      }
      return findList($, nameLower);
    case 'string': default: return findText($, nameLower);
  }
}
```

Update `autoDiscover` — add after the `links` block:

```typescript
  // Tables — require 3+ data rows to avoid extracting layout/nav tables
  const tableData = findTable($, '');
  if (tableData && tableData.length >= 3) {
    data.tables = tableData;
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && pnpm test -- --run css-extractor`
Expected: ALL PASS

- [x] **Step 5: Commit**

```bash
git add packages/core/src/extraction/css-extractor.ts packages/core/tests/unit/extraction/css-extractor.test.ts
git commit -m "feat(core): add HTML table extraction to CSS extractor via array+object fields"
```

---

## Task 3: `spatula add` Crawl History Dedup

**Files:**
- Modify: `packages/db/src/project-db/repositories/crawl-task-repository.ts`
- Modify: `apps/cli/src/commands/add.ts`
- Modify: `apps/cli/src/index.tsx:178-196`
- Test: `apps/cli/tests/unit/commands/add.test.ts`

- [x] **Step 1: Write failing test for findCompletedUrls**

In the appropriate test file (create `packages/db/tests/unit/project-db/crawl-task-repo.test.ts` if needed or use existing):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
// Use the same in-memory DB pattern as other project-db tests

describe('SqliteCrawlTaskRepository.findCompletedUrls', () => {
  it('returns URLs of completed tasks', async () => {
    // Insert tasks with various statuses
    await repo.enqueue({ jobId: 'j1', tenantId: 't1', url: 'https://a.com', depth: 0, parentTaskId: '' });
    await repo.enqueue({ jobId: 'j1', tenantId: 't1', url: 'https://b.com', depth: 0, parentTaskId: '' });
    await repo.enqueue({ jobId: 'j1', tenantId: 't1', url: 'https://c.com', depth: 0, parentTaskId: '' });
    // Mark first two as completed
    // (get IDs from inserts and update status)
    const urls = await repo.findCompletedUrls();
    expect(urls).toContain('https://a.com');
    expect(urls).toContain('https://b.com');
    expect(urls).not.toContain('https://c.com');
  });

  it('returns empty array when no completed tasks', async () => {
    const urls = await repo.findCompletedUrls();
    expect(urls).toEqual([]);
  });
});
```

- [x] **Step 2: Implement findCompletedUrls**

In `packages/db/src/project-db/repositories/crawl-task-repository.ts`, add:

```typescript
  async findCompletedUrls(): Promise<string[]> {
    const rows = this.db
      .select({ url: crawlTasks.url })
      .from(crawlTasks)
      .where(
        and(
          eq(crawlTasks.jobId, this.projectId),
          eq(crawlTasks.status, 'completed'),
        ),
      )
      .all();
    return rows.map(r => r.url);
  }
```

- [x] **Step 3: Run repo test to verify it passes**

Run: `cd packages/db && pnpm test -- --run crawl-task`
Expected: PASS

- [x] **Step 4: Write failing tests for add command with history dedup**

In `apps/cli/tests/unit/commands/add.test.ts`, add:

```typescript
describe('validateAndDedup with crawl history', () => {
  it('marks already-crawled URLs separately from config duplicates', () => {
    const result = validateAndDedup(
      ['https://new.com', 'https://crawled.com', 'https://in-yaml.com'],
      ['https://in-yaml.com'],
      ['https://crawled.com'],
    );
    expect(result.valid).toEqual(['https://new.com']);
    expect(result.duplicates).toEqual(['https://in-yaml.com']);
    expect(result.alreadyCrawled).toEqual(['https://crawled.com']);
  });

  it('works without crawl history (backward compatible)', () => {
    const result = validateAndDedup(['https://a.com'], ['https://b.com']);
    expect(result.valid).toEqual(['https://a.com']);
    expect(result.alreadyCrawled).toEqual([]);
  });
});
```

- [x] **Step 5: Update validateAndDedup and interfaces**

In `apps/cli/src/commands/add.ts`:

```typescript
export interface DeduplicationResult {
  valid: string[];
  invalid: string[];
  duplicates: string[];
  alreadyCrawled: string[];
}

export function validateAndDedup(
  urls: string[],
  existingSeeds: string[],
  crawledUrls?: string[],
): DeduplicationResult {
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const alreadyCrawled: string[] = [];
  const valid: string[] = [];
  const existingNorm = new Set(existingSeeds.map(normaliseUrl));
  const crawledNorm = new Set((crawledUrls ?? []).map(normaliseUrl));
  const seenNorm = new Set<string>();

  for (const url of urls) {
    try { new URL(url); } catch { invalid.push(url); continue; }
    const norm = normaliseUrl(url);
    if (existingNorm.has(norm)) { duplicates.push(url); continue; }
    if (crawledNorm.has(norm)) { alreadyCrawled.push(url); continue; }
    if (seenNorm.has(norm)) continue;
    seenNorm.add(norm);
    valid.push(url);
  }
  return { valid, invalid, duplicates, alreadyCrawled };
}
```

Update `AddResult` to include `alreadyCrawled: string[]`.

Update `runAddCommand` to open the DB:

```typescript
export async function runAddCommand(urls: string[], options?: { noHistory?: boolean }): Promise<AddResult> {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) throw new Error('No spatula.yaml found. Run `spatula init` to create a project first.');

  const yamlPath = join(projectRoot, 'spatula.yaml');
  const content = readFileSync(yamlPath, 'utf-8');
  const doc = parseYaml(content) as Record<string, unknown>;
  const existingSeeds = (doc.seeds as string[]) ?? [];

  // Crawl history lookup (graceful degradation)
  let crawledUrls: string[] = [];
  if (!options?.noHistory) {
    try {
      const { openLocalProject } = await import('../local-project.js');
      const project = await openLocalProject(process.cwd());
      try {
        crawledUrls = await project.adapter.taskRepo.findCompletedUrls();
      } finally {
        project.close();
      }
    } catch {
      // DB doesn't exist or can't be opened — skip history check
    }
  }

  const { valid, invalid, duplicates, alreadyCrawled } = validateAndDedup(urls, existingSeeds, crawledUrls);

  if (valid.length > 0) {
    doc.seeds = [...existingSeeds, ...valid];
    writeFileSync(yamlPath, stringifyYaml(doc, { lineWidth: 0 }), 'utf-8');
  }
  return { added: valid, invalid, duplicates, alreadyCrawled };
}
```

Update `formatAddResult` to display `alreadyCrawled`:

```typescript
if (result.alreadyCrawled.length > 0) {
  lines.push(`Skipped ${result.alreadyCrawled.length} already crawled:`);
  for (const url of result.alreadyCrawled) lines.push(`  ↻ ${url}`);
}
```

- [x] **Step 6: Register --no-history flag in CLI**

In `apps/cli/src/index.tsx`, update the `add` command (around line 178):

```typescript
  .command(
    'add <urls..>',
    'Add seed URLs to the project',
    (y) =>
      y.positional('urls', {
        type: 'string',
        array: true,
        demandOption: true,
        describe: 'URLs to add as seeds',
      }).option('no-history', {
        type: 'boolean',
        default: false,
        describe: 'Skip crawl history dedup (allow re-adding crawled URLs)',
      }),
    async (argv) => {
      try {
        const result = await runAddCommand(argv.urls as string[], { noHistory: argv.noHistory });
        console.log(formatAddResult(result));
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : 'An unexpected error occurred');
        process.exit(1);
      }
    },
  )
```

- [x] **Step 7: Run all add tests**

Run: `cd apps/cli && pnpm test -- --run add`
Expected: ALL PASS

- [x] **Step 8: Commit**

```bash
git add packages/db/src/project-db/repositories/crawl-task-repository.ts apps/cli/src/commands/add.ts apps/cli/src/index.tsx apps/cli/tests/unit/commands/add.test.ts
git commit -m "feat(cli): add crawl history dedup to spatula add with --no-history bypass"
```

---

## Task 4: Tenant Creation Auth Protection

**Files:**
- Modify: `apps/api/src/app.ts:126-129`
- Test: `apps/api/tests/unit/routes/tenants.test.ts` (or appropriate test file)

- [x] **Step 1: Write failing test**

```typescript
describe('POST /api/v1/tenants auth protection', () => {
  it('returns 403 when TENANT_CREATION_SECRET is set and header is missing', async () => {
    process.env.TENANT_CREATION_SECRET = 'test-secret-123';
    const res = await app.request('/api/v1/tenants', { method: 'POST', body: JSON.stringify({ name: 'test' }) });
    expect(res.status).toBe(403);
    delete process.env.TENANT_CREATION_SECRET;
  });

  it('allows creation when secret matches', async () => {
    process.env.TENANT_CREATION_SECRET = 'test-secret-123';
    const res = await app.request('/api/v1/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Creation-Secret': 'test-secret-123' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).not.toBe(403);
    delete process.env.TENANT_CREATION_SECRET;
  });

  it('allows creation when TENANT_CREATION_SECRET is not set', async () => {
    delete process.env.TENANT_CREATION_SECRET;
    const res = await app.request('/api/v1/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).not.toBe(403);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- --run tenants`
Expected: FAIL — no auth check exists

- [x] **Step 3: Add creation secret middleware**

In `apps/api/src/app.ts`, replace lines 126-129:

```typescript
  // Tenant management routes — protected by shared secret in production
  const creationSecret = process.env.TENANT_CREATION_SECRET;
  if (creationSecret) {
    app.post('/api/v1/tenants', async (c, next) => {
      if (c.req.header('X-Creation-Secret') !== creationSecret) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid creation secret' } }, 403);
      }
      return next();
    });
  }
  app.route('/api/v1/tenants', tenantRoutes());
```

- [x] **Step 4: Add env var to .env.example**

Append to `.env.example`:

```
# Tenant creation protection (optional — leave unset for open bootstrap in dev/self-hosted)
# TENANT_CREATION_SECRET=your-secret-here
```

- [x] **Step 5: Run tests and commit**

Run: `cd apps/api && pnpm test -- --run tenants`
Expected: ALL PASS

```bash
git add apps/api/src/app.ts .env.example apps/api/tests/
git commit -m "fix(api): add shared-secret protection for tenant creation endpoint"
```

---

## Task 5: Quota Audit Logging

**Files:**
- Modify: `packages/queue/src/job-manager.ts:19,28,36,53-72`
- Test: `packages/queue/tests/unit/job-manager.test.ts`

- [x] **Step 1: Write failing test**

```typescript
it('logs audit event on monthly quota exceeded', async () => {
  const auditLog = vi.fn();
  const auditLogger = { log: auditLog } as unknown as AuditLogger;
  const manager = new JobManager({
    jobRepo, taskRepo, schemaRepo, queues, tenantRepo,
    quotaEnforcer: {
      checkAndRecord: vi.fn().mockRejectedValue(
        new QuotaExceededError('Monthly job limit reached: 5/5', { context: { tenantId: 't1', current: 5, max: 5 } }),
      ),
    },
    auditLogger,
  });

  // Quota is checked in startJob, not createJob
  await expect(manager.startJob('job1', 't1')).rejects.toThrow(QuotaExceededError);
  expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
    action: 'quota.exceeded',
    actorId: 'system',
    actorType: 'system',
    tenantId: 't1',
    metadata: expect.objectContaining({ dimension: 'jobs' }),
  }));
});

it('logs audit event on concurrent job quota exceeded', async () => {
  const auditLog = vi.fn();
  const auditLogger = { log: auditLog } as unknown as AuditLogger;
  const manager = new JobManager({
    jobRepo, taskRepo, schemaRepo, queues,
    tenantRepo: { getQuotas: vi.fn().mockResolvedValue({ maxConcurrentJobs: 2 }) },
    auditLogger,
  });
  jobRepo.countByTenant = vi.fn().mockResolvedValue(2); // at limit

  await expect(manager.startJob('job1', 't1')).rejects.toThrow(QuotaExceededError);
  expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
    action: 'quota.exceeded',
    metadata: expect.objectContaining({ dimension: 'concurrent_jobs', current: 2, max: 2 }),
  }));
});
```

- [x] **Step 2: Implement audit logging in JobManager**

In `packages/queue/src/job-manager.ts`:

Add `auditLogger?: AuditLogger` to `JobManagerConfig` interface (line 19) and import `AuditLogger` from `@spatula/shared`.
Add `private readonly auditLogger?: AuditLogger` field (line 28) and wire in constructor (line 36).

Wrap the `quotaEnforcer.checkAndRecord` call (line 54-56) in a try/catch:

```typescript
    if (this.quotaEnforcer) {
      try {
        await this.quotaEnforcer.checkAndRecord(tenantId, 'jobs', 1);
      } catch (error) {
        if (error instanceof QuotaExceededError && this.auditLogger) {
          this.auditLogger.log({
            action: 'quota.exceeded',
            actorId: 'system',
            actorType: 'system',
            tenantId,
            metadata: { dimension: 'jobs' },
          });
        }
        throw error;
      }
    }
```

For concurrent job quota (lines 64-68), add audit before throw:

```typescript
        if (runningCount >= maxConcurrent) {
          if (this.auditLogger) {
            this.auditLogger.log({
              action: 'quota.exceeded',
              actorId: 'system',
              actorType: 'system',
              tenantId,
              metadata: { dimension: 'concurrent_jobs', current: runningCount, max: maxConcurrent },
            });
          }
          throw new QuotaExceededError(
            `Concurrent job limit reached: ${runningCount}/${maxConcurrent}`,
            { context: { tenantId, current: runningCount, max: maxConcurrent } },
          );
        }
```

- [x] **Step 3: Run tests and commit**

Run: `cd packages/queue && pnpm test -- --run job-manager`
Expected: ALL PASS

```bash
git add packages/queue/src/job-manager.ts packages/queue/tests/
git commit -m "feat(queue): add audit logging for quota exceeded events in JobManager"
```

---

## Task 6: OpenRouter Cost Header Extraction

**Files:**
- Modify: `packages/core/src/llm/openrouter-client.ts:74-108`
- Test: `packages/core/tests/unit/llm/openrouter-client.test.ts`

- [x] **Step 1: Write failing test**

```typescript
it('extracts cost from x-openrouter-cost header', async () => {
  const recorder = { record: vi.fn() };
  // Mock fetch to return response with cost header
  const mockResponse = new Response(JSON.stringify({
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: 'test-model',
  }), {
    headers: { 'x-openrouter-cost': '0.00042' },
  });
  vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

  const client = new OpenRouterClient({ apiKey: 'k', usageRecorder: recorder });
  await client.complete({ model: 'test', messages: [{ role: 'user', content: 'hi' }] });

  expect(recorder.record).toHaveBeenCalledWith(
    expect.objectContaining({ costUsd: 0.00042 }),
  );
});
```

- [x] **Step 2: Implement cost extraction**

In `packages/core/src/llm/openrouter-client.ts`, after line 74 (`const response = await this.doFetch(body);`), before the `.json()` call:

```typescript
        const costUsd = parseFloat(response.headers.get('x-openrouter-cost') ?? '') || 0;
```

Then at line 106, replace `costUsd: 0` with `costUsd`:

```typescript
            costUsd,
```

Remove the TODO comment.

- [x] **Step 3: Run tests and commit**

Run: `cd packages/core && pnpm test -- --run openrouter`
Expected: ALL PASS

```bash
git add packages/core/src/llm/openrouter-client.ts packages/core/tests/
git commit -m "feat(core): extract cost from OpenRouter x-openrouter-cost response header"
```

---

## Task 7: Observable Gauge Registration

**Files:**
- Modify: `packages/shared/src/metrics.ts:46-48`
- Test: `packages/shared/tests/unit/metrics.test.ts`

- [x] **Step 1: Write failing test**

```typescript
describe('registerGauges', () => {
  it('does not throw when metrics are initialized', () => {
    // createMetrics stores the meter in module state
    createMetrics({ enabled: false });
    const deps = {
      jobRepo: { countByStatus: vi.fn().mockResolvedValue(3) },
      tenantRepo: { countAll: vi.fn().mockResolvedValue(10) },
      queueProvider: { getQueueDepth: vi.fn().mockResolvedValue(5) },
    };
    // registerGauges reads the module-level _meter set by createMetrics
    expect(() => registerGauges(deps)).not.toThrow();
  });
});
```

- [x] **Step 2: Implement registerGauges**

In `packages/shared/src/metrics.ts`:

First, store the meter as a module-level variable. Change the existing code inside `createMetrics`:

```typescript
// Module-level variable (add near top of file, after imports)
let _meter: Meter | undefined;

// Inside createMetrics(), after creating the meter:
  const meter = meterProvider.getMeter('spatula');
  _meter = meter; // Store for registerGauges
```

Then add `registerGauges` after `createMetrics`:

```typescript
export function registerGauges(
  deps: {
    jobRepo: { countByStatus: (status: string) => Promise<number> };
    tenantRepo: { countAll: () => Promise<number> };
    queueProvider: { getQueueDepth: () => Promise<number> };
  },
): void {
  if (!_meter) return;

  _meter.createObservableGauge('active_jobs', { description: 'Currently running jobs' })
    .addCallback(async (result) => {
      try { result.observe(await deps.jobRepo.countByStatus('running')); }
      catch { result.observe(0); }
    });

  _meter.createObservableGauge('tenant_count', { description: 'Total tenants' })
    .addCallback(async (result) => {
      try { result.observe(await deps.tenantRepo.countAll()); }
      catch { result.observe(0); }
    });

  _meter.createObservableGauge('queue_depth', { description: 'Total pending queue items' })
    .addCallback(async (result) => {
      try { result.observe(await deps.queueProvider.getQueueDepth()); }
      catch { result.observe(0); }
    });
}
```

Remove the TODO comment at line 46. Store `meter` as a module-level variable accessible to `registerGauges`.

Note: The exact API for `ObservableGauge.addCallback` depends on the OpenTelemetry SDK version. Check `node_modules/@opentelemetry/api/build/src/metrics/Meter.d.ts` for the correct callback signature.

- [x] **Step 3: Run tests and commit**

Run: `cd packages/shared && pnpm test -- --run metrics`
Expected: ALL PASS

```bash
git add packages/shared/src/metrics.ts packages/shared/tests/
git commit -m "feat(shared): register observable gauges for active_jobs, tenant_count, queue_depth"
```

---

## Task 8: SQLite Migration — Add runId and pageUrl Columns

**Files:**
- Modify: `packages/db/src/schema-sqlite/extractions.ts`
- Modify: `packages/db/src/schema-sqlite/actions.ts`
- Create: `packages/db/drizzle-sqlite/0006_*.sql` (generated by Drizzle Kit)

- [x] **Step 1: Update extraction schema**

In `packages/db/src/schema-sqlite/extractions.ts`, change `pageId` to nullable and add `runId` + `pageUrl`:

```typescript
    pageId: text('page_id'),  // was .notNull() — nullable for remote-pulled records
    // ... existing columns unchanged ...
    // New columns for pull flow
    runId: text('run_id'),
    pageUrl: text('page_url'),
  },
  (table) => [
    index('sl_extractions_job_schema_idx').on(table.jobId, table.schemaVersion),
    index('sl_extractions_page_idx').on(table.pageId),
    index('sl_extractions_run_id_idx').on(table.runId),
  ],
```

- [x] **Step 2: Update action schema**

In `packages/db/src/schema-sqlite/actions.ts`, add `runId`:

```typescript
    updatedAt: text('updated_at').notNull(),
    runId: text('run_id'),
  },
  (table) => [
    index('sl_actions_job_type_idx').on(table.jobId, table.type),
    index('sl_actions_job_status_idx').on(table.jobId, table.status),
    index('sl_actions_job_created_idx').on(table.jobId, table.createdAt),
    index('sl_actions_run_id_idx').on(table.runId),
    // ... existing CHECK constraints unchanged
```

- [x] **Step 3: Generate migration**

Run: `cd packages/db && pnpm db:generate:sqlite`

This generates a new migration file in `drizzle-sqlite/`. Because `pageId` is changing from NOT NULL to nullable, Drizzle Kit will generate a table recreation migration for the extractions table. Verify the generated SQL preserves existing data (should use a temporary table copy pattern).

- [x] **Step 4: Test migration against populated DB**

Create a test that seeds data into extractions and actions, runs the migration, and verifies data is preserved:

```typescript
it('preserves existing extraction data after migration', () => {
  // Create DB with old schema, insert test data, close
  // Re-open with new schema (triggers migration)
  // Verify test data still exists with original values
  // Verify new columns (runId, pageUrl) are null
});
```

Run: `cd packages/db && pnpm test -- --run migration`

- [x] **Step 5: Commit**

```bash
git add packages/db/src/schema-sqlite/extractions.ts packages/db/src/schema-sqlite/actions.ts packages/db/drizzle-sqlite/
git commit -m "feat(db): add runId/pageUrl columns to SQLite extractions and actions for pull flow"
```

---

## Task 9: Server-Side Changes — Extraction pageUrl Join + Entity-Sources Endpoint + Job Stats

**Files:**
- Modify: `packages/db/src/repositories/extraction-repository.ts` (Postgres — add pageUrl join)
- Modify: `apps/api/src/schemas/responses.ts:36-46` (extractionResponseSchema)
- Create: `apps/api/src/routes/entity-sources.ts`
- Modify: `apps/api/src/app.ts` (register entity-sources route)
- Modify: `packages/db/src/repositories/job-repository.ts` (stats enrichment)
- Test: `apps/api/tests/unit/routes/extractions.test.ts`, `apps/api/tests/unit/routes/entity-sources.test.ts`

- [x] **Step 1: Update extractionResponseSchema**

In `apps/api/src/schemas/responses.ts`:

```typescript
export const extractionResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  pageId: z.string().uuid().nullable(),
  pageUrl: z.string().nullable(),
  schemaVersion: z.number().int(),
  data: z.record(z.unknown()),
  unmappedFields: z.array(z.unknown()).nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
}).openapi('Extraction');
```

- [x] **Step 2: Add pageUrl join to Postgres extraction repository**

In `packages/db/src/repositories/extraction-repository.ts`, update `findByJobCursor` to LEFT JOIN with `rawPages`:

```typescript
import { rawPages } from '../schema/raw-pages.js';

// In findByJobCursor:
const rows = await this.db
  .select({
    id: extractions.id,
    jobId: extractions.jobId,
    tenantId: extractions.tenantId,
    pageId: extractions.pageId,
    pageUrl: rawPages.url,
    schemaVersion: extractions.schemaVersion,
    data: extractions.data,
    unmappedFields: extractions.unmappedFields,
    metadata: extractions.metadata,
    createdAt: extractions.createdAt,
  })
  .from(extractions)
  .leftJoin(rawPages, eq(extractions.pageId, rawPages.id))
  .where(and(...conditions))
  .orderBy(extractions.id)
  .limit(limit);
```

Apply the same join to the `findByJob` offset-based query.

- [x] **Step 3: Create entity-sources route**

Create `apps/api/src/routes/entity-sources.ts`:

```typescript
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import type { AppEnv } from '../types.js';
import { paginationSchema, paginationEnvelopeSchema } from '../schemas/pagination.js';
import { jsonContent } from '../schemas/responses.js';
import { decodeCursor, encodeCursor } from '@spatula/shared';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const entitySourceSchema = z.object({
  entityId: z.string().uuid(),
  extractionId: z.string().uuid(),
  matchConfidence: z.number(),
});

const listRoute = createRoute({
  method: 'get', path: '/', tags: ['EntitySources'],
  summary: 'List entity-extraction linkages for a job',
  request: { params: jobIdParam, query: paginationSchema },
  responses: {
    200: jsonContent(
      z.object({ data: z.array(entitySourceSchema), pagination: paginationEnvelopeSchema }),
      'Entity sources with pagination',
    ),
  },
});

export function entitySourceRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const cursorId = query.cursor ? decodeCursor(query.cursor).id : undefined;
    const result = await deps.entitySourceRepo.findByJobCursor(
      jobId, tenantId, query.limit, cursorId, query.since,
    );
    const total = await deps.entitySourceRepo.countByJob(jobId, tenantId);

    return c.json({
      data: result.entities,
      pagination: {
        total,
        limit: query.limit,
        hasMore: !!result.nextCursor,
        nextCursor: result.nextCursor ? encodeCursor({ id: result.nextCursor }) : undefined,
      },
    });
  });

  return router;
}
```

- [x] **Step 4: Register route in app.ts**

In `apps/api/src/app.ts`, add after the extractions route registration:

```typescript
  import { entitySourceRoutes } from './routes/entity-sources.js';
  // ...
  app.route('/api/v1/jobs/:jobId/entity-sources', entitySourceRoutes());
```

Ensure it's within the tenant-scoped middleware chain (after auth middleware).

- [x] **Step 5: Add findByJobCursor and countByJob to EntitySourceRepository (Postgres)**

In `packages/db/src/repositories/entity-source-repository.ts`, add:

```typescript
import { sql, and, eq } from 'drizzle-orm';
import { entities } from '../schema/entities.js';

  async findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    since?: string,
  ) {
    try {
      // entity_sources doesn't have jobId — join through entities
      const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];
      if (cursor) conditions.push(sql`${entitySources.entityId} > ${cursor}::uuid`);
      if (since) conditions.push(sql`${entities.updatedAt} > ${since}`);

      const rows = await this.db
        .select({
          entityId: entitySources.entityId,
          extractionId: entitySources.extractionId,
          matchConfidence: entitySources.matchConfidence,
        })
        .from(entitySources)
        .innerJoin(entities, eq(entitySources.entityId, entities.id))
        .where(and(...conditions))
        .orderBy(entitySources.entityId)
        .limit(limit);

      const nextCursor = rows.length === limit ? rows[rows.length - 1].entityId : null;
      return { entities: rows, nextCursor };
    } catch (error) {
      throw new StorageError(`Failed to fetch entity sources by cursor: ${(error as Error).message}`, {
        cause: error as Error, context: { jobId, tenantId },
      });
    }
  }

  async countByJob(jobId: string, tenantId: string): Promise<number> {
    try {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(entitySources)
        .innerJoin(entities, eq(entitySources.entityId, entities.id))
        .where(and(eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)));
      return Number(row?.count ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to count entity sources: ${(error as Error).message}`, {
        cause: error as Error, context: { jobId, tenantId },
      });
    }
  }
```

- [x] **Step 6: Add countByStatus to ActionRepository (Postgres)**

In `packages/db/src/repositories/action-repository.ts`, add:

```typescript
  async countByJobAndStatus(jobId: string, tenantId: string, status: string): Promise<number> {
    try {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(actions)
        .where(and(eq(actions.jobId, jobId), eq(actions.tenantId, tenantId), eq(actions.status, status)));
      return Number(row?.count ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to count actions: ${(error as Error).message}`, {
        cause: error as Error, context: { jobId, tenantId },
      });
    }
  }
```

- [x] **Step 7: Enrich job stats in job detail route**

In `apps/api/src/routes/jobs.ts`, in the GET `/:jobId` handler, after fetching the job, compute and merge additional stats:

```typescript
    // Enrich stats with pending actions count and schema field count
    const pendingActionsCount = await deps.actionRepo.countByJobAndStatus(jobId, tenantId, 'pending_review');
    const latestSchema = await deps.schemaRepo.findLatest(jobId, tenantId);
    const schemaFieldCount = (latestSchema?.definition as any)?.fields?.length ?? 0;

    const enrichedStats = {
      ...(job.stats as Record<string, number> ?? {}),
      pendingActionsCount,
      schemaFieldCount,
    };

    return c.json({ data: { ...job, stats: enrichedStats } });
```

- [x] **Step 8: Run API tests and commit**

Run: `cd apps/api && pnpm test -- --run`
Expected: ALL PASS

```bash
git add apps/api/src/routes/entity-sources.ts apps/api/src/routes/jobs.ts apps/api/src/app.ts apps/api/src/schemas/responses.ts packages/db/src/repositories/
git commit -m "feat(api): add pageUrl to extractions, entity-sources endpoint, job stats enrichment"
```

---

## Task 10: API Client Paginated Methods

**Files:**
- Modify: `apps/cli/src/api/client.ts`
- Test: `apps/cli/tests/unit/api/client-pull.test.ts`

- [x] **Step 1: Write failing tests**

```typescript
describe('getExtractionsStreamPaginated', () => {
  it('returns data with pagination envelope', async () => {
    mockFetch({ data: [{ id: 'e1' }], pagination: { hasMore: false, total: 1 } });
    const result = await client.getExtractionsStreamPaginated('job1');
    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
  });
});

describe('getActionsStreamPaginated', () => {
  it('returns data with pagination envelope', async () => {
    mockFetch({ data: [{ id: 'a1' }], pagination: { hasMore: false, total: 1 } });
    const result = await client.getActionsStreamPaginated('job1');
    expect(result.data).toHaveLength(1);
  });
});

describe('getEntitySourcesStreamPaginated', () => {
  it('returns data with pagination envelope', async () => {
    mockFetch({ data: [{ entityId: 'e1', extractionId: 'x1', matchConfidence: 0.9 }], pagination: { hasMore: false, total: 1 } });
    const result = await client.getEntitySourcesStreamPaginated('job1');
    expect(result.data).toHaveLength(1);
  });
});
```

- [x] **Step 2: Implement three paginated methods**

In `apps/cli/src/api/client.ts`, first extract a shared `fetchPaginated` private method from `getEntitiesStreamPaginated`:

```typescript
  private async fetchPaginated(url: string): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      throw new ApiError(0, 'NETWORK_ERROR', (err as Error).message);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(
        response.status,
        (body as { error?: { code?: string } }).error?.code,
        (body as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`,
      );
    }

    const json = await response.json();
    return {
      data: ((json as { data?: unknown }).data ?? []) as Record<string, unknown>[],
      pagination: (json as { pagination?: unknown }).pagination as {
        nextCursor?: string; hasMore: boolean; total: number;
      },
    };
  }
```

Then refactor `getEntitiesStreamPaginated` to use it, and add the three new methods:

```typescript
  async getExtractionsStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/extractions`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: query.limit } : {}),
    });
    return this.fetchPaginated(url);
  }

  async getActionsStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/actions`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: query.limit } : {}),
    });
    return this.fetchPaginated(url);
  }

  async getEntitySourcesStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/entity-sources`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: query.limit } : {}),
    });
    return this.fetchPaginated(url);
  }
```

Extract a shared `fetchPaginated` private method from `getEntitiesStreamPaginated` to DRY up the common fetch+parse logic.

- [x] **Step 3: Run tests and commit**

Run: `cd apps/cli && pnpm test -- --run client`
Expected: ALL PASS

```bash
git add apps/cli/src/api/client.ts apps/cli/tests/
git commit -m "feat(cli): add paginated API client methods for extractions, actions, entity-sources"
```

---

## Task 11: SQLite Repo Batch Methods

**Files:**
- Modify: `packages/db/src/project-db/repositories/extraction-repository.ts`
- Modify: `packages/db/src/project-db/repositories/action-repository.ts`
- Modify: `packages/db/src/project-db/repositories/entity-repository.ts` (entity source batch methods)
- Test: corresponding test files

- [x] **Step 1: Write failing tests for extraction upsertBatch and deleteByRunIds**

```typescript
describe('SqliteExtractionRepository.upsertBatch', () => {
  it('inserts new extractions and returns counts', async () => {
    const result = await repo.upsertBatch([
      { id: 'e1', pageId: null, pageUrl: 'https://a.com', schemaVersion: 1, data: { a: 1 }, unmappedFields: [], metadata: {}, runId: 'run-1' },
      { id: 'e2', pageId: null, pageUrl: 'https://b.com', schemaVersion: 1, data: { b: 2 }, unmappedFields: [], metadata: {}, runId: 'run-1' },
    ]);
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
  });

  it('updates existing extractions on conflict', async () => {
    await repo.upsertBatch([{ id: 'e1', pageId: null, pageUrl: 'https://a.com', schemaVersion: 1, data: { a: 1 }, unmappedFields: [], metadata: {}, runId: 'run-1' }]);
    const result = await repo.upsertBatch([{ id: 'e1', pageId: null, pageUrl: 'https://a.com', schemaVersion: 1, data: { a: 999 }, unmappedFields: [], metadata: {}, runId: 'run-2' }]);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
  });
});

describe('SqliteExtractionRepository.deleteByRunIds', () => {
  it('deletes extractions matching given runIds', async () => {
    await repo.upsertBatch([
      { id: 'e1', pageId: null, pageUrl: 'https://a.com', schemaVersion: 1, data: {}, unmappedFields: [], metadata: {}, runId: 'run-1' },
      { id: 'e2', pageId: null, pageUrl: 'https://b.com', schemaVersion: 1, data: {}, unmappedFields: [], metadata: {}, runId: 'run-2' },
    ]);
    const deleted = await repo.deleteByRunIds(['run-1']);
    expect(deleted).toBe(1);
  });
});
```

- [x] **Step 2: Implement extraction upsertBatch and deleteByRunIds**

In `packages/db/src/project-db/repositories/extraction-repository.ts`, add methods following the entity `upsertBatch` pattern:

```typescript
  async upsertBatch(batch: Array<{
    id: string;
    pageId: string | null;
    pageUrl: string | null;
    schemaVersion: number;
    data: Record<string, unknown>;
    unmappedFields: Record<string, unknown>[];
    metadata: Record<string, unknown>;
    runId: string | null;
  }>): Promise<{ inserted: number; updated: number }> {
    if (batch.length === 0) return { inserted: 0, updated: 0 };

    const existingIds = new Set<string>();
    wrapStorageError(() => {
      for (const item of batch) {
        const row = this.db.select({ id: extractions.id }).from(extractions).where(eq(extractions.id, item.id)).get();
        if (row) existingIds.add(item.id);
      }
    }, { method: 'upsertBatch:check', table: 'extractions' });

    const now = new Date().toISOString();
    wrapStorageError(() => {
      for (const item of batch) {
        this.db.insert(extractions).values({
          id: item.id,
          jobId: this.projectId,
          pageId: item.pageId,
          pageUrl: item.pageUrl,
          schemaVersion: item.schemaVersion,
          data: item.data,
          unmappedFields: item.unmappedFields,
          metadata: item.metadata,
          createdAt: now,
          updatedAt: now,
          runId: item.runId,
        }).onConflictDoUpdate({
          target: extractions.id,
          set: { data: item.data, unmappedFields: item.unmappedFields, metadata: item.metadata, updatedAt: now, runId: item.runId },
        }).run();
      }
    }, { method: 'upsertBatch', table: 'extractions' });

    return { inserted: batch.length - existingIds.size, updated: existingIds.size };
  }

  async deleteByRunIds(runIds: string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    let total = 0;
    wrapStorageError(() => {
      for (const runId of runIds) {
        const result = this.db.delete(extractions).where(
          and(eq(extractions.jobId, this.projectId), eq(extractions.runId, runId)),
        ).run();
        total += result.changes;
      }
    }, { method: 'deleteByRunIds', table: 'extractions' });
    return total;
  }
```

- [x] **Step 3: Implement action upsertBatch and deleteByRunIds**

Same pattern in `packages/db/src/project-db/repositories/action-repository.ts`. Note: action `source` column has a CHECK constraint — pulled actions must have a valid source value from `('extraction','schema_evolution','reconciliation','quality_audit')`.

- [x] **Step 4: Add entity source batch methods**

In `packages/db/src/project-db/repositories/entity-repository.ts` (where `SqliteEntitySourceRepository` lives), add:

```typescript
  async upsertBatchSources(batch: Array<{
    entityId: string;
    extractionId: string;
    matchConfidence: number;
  }>): Promise<number> {
    if (batch.length === 0) return 0;
    let count = 0;
    wrapStorageError(() => {
      for (const item of batch) {
        this.db.insert(entitySources).values(item)
          .onConflictDoUpdate({
            target: [entitySources.entityId, entitySources.extractionId],
            set: { matchConfidence: item.matchConfidence },
          }).run();
        count++;
      }
    }, { method: 'upsertBatchSources', table: 'entity_sources' });
    return count;
  }

  async deleteByExtractionIds(extractionIds: string[]): Promise<number> {
    if (extractionIds.length === 0) return 0;
    let total = 0;
    wrapStorageError(() => {
      for (const id of extractionIds) {
        const result = this.db.delete(entitySources)
          .where(eq(entitySources.extractionId, id)).run();
        total += result.changes;
      }
    }, { method: 'deleteByExtractionIds', table: 'entity_sources' });
    return total;
  }
```

- [x] **Step 5: Run all repo tests**

Run: `cd packages/db && pnpm test -- --run`
Expected: ALL PASS

- [x] **Step 6: Commit**

```bash
git add packages/db/src/project-db/repositories/
git commit -m "feat(db): add upsertBatch/deleteByRunIds for extractions, actions, entity sources"
```

---

## Task 12: `spatula reset --keep-remote`

**Files:**
- Modify: `apps/cli/src/commands/reset.ts`
- Modify: `apps/cli/src/index.tsx` (flag registration)
- Test: `apps/cli/tests/unit/commands/reset.test.ts`

- [x] **Step 1: Write failing tests**

```typescript
describe('reset --keep-remote', () => {
  it('preserves remote entities and project_meta remote keys', async () => {
    // Setup: create .spatula/ with project.db containing both local and remote data
    // Run reset with keepRemote: true
    // Verify: remote entities/meta preserved, local data cleared, dirs recreated
  });

  it('implies --keep-entities (DB file is preserved)', async () => {
    const result = await runResetCommand({ keepRemote: true, cwd: projectDir });
    expect(result.keptItems).toContain('project.db');
  });

  it('clears local entities but preserves remote ones', async () => {
    // Insert entities with runId=null (local) and runId='remote:default:job1' (remote)
    // Run reset with keepRemote
    // Query DB: remote entities exist, local ones gone
  });
});
```

- [x] **Step 2: Implement --keep-remote**

In `apps/cli/src/commands/reset.ts`:

Add `keepRemote?: boolean` to `ResetOptions`.

In `runResetCommand`, after the filesystem cleanup loop, if `keepRemote`:

```typescript
    // --keep-remote implies --keep-entities
    if (options.keepRemote) {
      options.keepEntities = true;
    }

    // ... existing cleanup loop ...

    // Selective DB cleanup for --keep-remote
    // Note: uses raw better-sqlite3 handle (sqlite) for bulk deletes since Drizzle's
    // query builder doesn't support complex WHERE with NOT LIKE + IS NULL patterns easily.
    // createProjectDb returns { db, sqlite, close } where sqlite is the raw handle.
    if (options.keepRemote) {
      const dbPath = join(spatulaDir, DB_FILE);
      if (existsSync(dbPath)) {
        const { createProjectDb } = await import('@spatula/db/project-db');
        const { sqlite, close } = createProjectDb(dbPath);
        try {
          // Delete local entities (runId null = pre-pull local, non-remote prefix = local runs)
          sqlite.prepare(`DELETE FROM entities WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'`).run();
          sqlite.prepare(`DELETE FROM extractions WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'`).run();
          sqlite.prepare(`DELETE FROM actions WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'`).run();
          // crawl_tasks and pages are always local
          sqlite.prepare(`DELETE FROM crawl_tasks`).run();
          sqlite.prepare(`DELETE FROM pages`).run();
          sqlite.prepare(`DELETE FROM runs WHERE source = 'local'`).run();
          // Preserve remote:* keys and core metadata
          sqlite.prepare(`DELETE FROM project_meta WHERE key NOT LIKE 'remote:%' AND key NOT IN ('schema_version','project_id','project_name','created_at')`).run();
        } finally {
          close();
        }
      }
    }
```

- [x] **Step 3: Register flag in CLI**

In `apps/cli/src/index.tsx`, add to the reset command options:

```typescript
        .option('keep-remote', {
          type: 'boolean',
          default: false,
          describe: 'Preserve remote job links and pulled data',
        }),
```

Pass `keepRemote: argv.keepRemote` to `runResetCommand`.

- [x] **Step 4: Run tests and commit**

Run: `cd apps/cli && pnpm test -- --run reset`
Expected: ALL PASS

```bash
git add apps/cli/src/commands/reset.ts apps/cli/src/index.tsx apps/cli/tests/
git commit -m "feat(cli): add --keep-remote flag to spatula reset"
```

---

## Task 13: Pull Flow Extension — Extractions, Entity Sources, Actions

**Files:**
- Modify: `apps/cli/src/commands/pull.ts` (PullInput, PullResult, runPullCommand, handlePullCommand)
- Modify: `apps/cli/src/index.tsx` (flag registration)
- Test: `apps/cli/tests/unit/commands/pull.test.ts`

This is the largest task. It extends the pull command with three new optional phases.

- [x] **Step 1: Extend PullInput and PullResult interfaces**

In `apps/cli/src/commands/pull.ts`:

Add to `PullInput`:
```typescript
  includeExtractions?: boolean;
  includeActions?: boolean;
  adapter: {
    // ... existing repos ...
    extractionRepo: {
      upsertBatch: (batch: Array<{
        id: string; pageId: string | null; pageUrl: string | null;
        schemaVersion: number; data: Record<string, unknown>;
        unmappedFields: Record<string, unknown>[]; metadata: Record<string, unknown>;
        runId: string | null;
      }>) => Promise<{ inserted: number; updated: number }>;
      deleteByRunIds: (runIds: string[]) => Promise<number>;
      findIdsByRunId?: (runId: string) => Promise<string[]>;
    };
    actionRepo: {
      upsertBatch: (batch: Array<{
        id: string; type: string; payload: Record<string, unknown>;
        source: string; status: string; confidence: number;
        reasoning: string; runId: string | null;
        createdAt: string; updatedAt: string; appliedAt: string | null;
        stateChanges?: Record<string, unknown> | null;
        reviewedBy?: string | null;
      }>) => Promise<{ inserted: number; updated: number }>;
      deleteByRunIds: (runIds: string[]) => Promise<number>;
      findIdsByRunId?: (runId: string) => Promise<string[]>;
    };
    entitySourceRepo: {
      upsertBatchSources: (batch: Array<{
        entityId: string; extractionId: string; matchConfidence: number;
      }>) => Promise<number>;
      deleteByExtractionIds: (extractionIds: string[]) => Promise<number>;
    };
  };
  onExtractionProgress?: (batch: number, total: number) => void;
  onActionProgress?: (batch: number, total: number) => void;
```

Add to `PullResult`:
```typescript
  extractionsInserted?: number;
  extractionsUpdated?: number;
  entitySourcesInserted?: number;
  actionsInserted?: number;
  actionsUpdated?: number;
```

- [x] **Step 2: Write failing tests for extraction pull**

```typescript
describe('pull with --include-extractions', () => {
  it('fetches and stores extractions after entities', async () => {
    // Mock client to return extractions
    mockClient.getExtractionsStreamPaginated.mockResolvedValueOnce({
      data: [{ id: 'x1', pageId: 'p1', pageUrl: 'https://a.com', schemaVersion: 1, data: { a: 1 }, unmappedFields: [], metadata: {} }],
      pagination: { hasMore: false, total: 1 },
    });
    mockClient.getEntitySourcesStreamPaginated.mockResolvedValueOnce({
      data: [{ entityId: 'e1', extractionId: 'x1', matchConfidence: 0.95 }],
      pagination: { hasMore: false, total: 1 },
    });

    const result = await runPullCommand({ ...baseInput, includeExtractions: true });
    expect(result.extractionsInserted).toBe(1);
    expect(result.entitySourcesInserted).toBe(1);
    expect(mockAdapter.extractionRepo.upsertBatch).toHaveBeenCalled();
  });

  it('uses separate cursor for extractions', async () => {
    // Verify pull_cursor_extractions is checkpointed independently
  });
});
```

- [x] **Step 3: Implement extraction pull phase in runPullCommand**

After the entity pull loop (around line 290 in current code), add:

```typescript
  // Step 6: Pull extractions (optional)
  let extractionsInserted = 0;
  let extractionsUpdated = 0;
  let entitySourcesInserted = 0;

  if (input.includeExtractions && input.adapter.extractionRepo) {
    // --full cleanup
    if (input.full) {
      const runIds = await input.adapter.runRepo.findIdsBySourcePrefix(`remote:${input.remoteName}:`);
      // Delete entity_sources referencing these extractions first (FK order)
      // Collect extraction IDs for these runs so we can clean entity_sources first (FK order)
      const extractionIds: string[] = [];
      for (const rid of runIds) {
        const exRows = await input.adapter.extractionRepo.findIdsByRunId?.(rid) ?? [];
        extractionIds.push(...exRows);
      }
      await input.adapter.entitySourceRepo.deleteByExtractionIds(extractionIds);
      await input.adapter.extractionRepo.deleteByRunIds(runIds);
    }

    // Resume from cursor
    if (input.restart) {
      await input.metaDelete(`remote:${input.remoteName}:pull_cursor_extractions`);
    }
    let extrCursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor_extractions`);
    let extrBatch = 0;
    let extrTotal = 0;

    while (true) {
      const page = await client.getExtractionsStreamPaginated(jobId, {
        cursor: extrCursor ?? undefined,
        since: input.full ? undefined : since ?? undefined,
        limit: 100,
      });

      if (page.data.length > 0) {
        const batch = page.data.map((e: Record<string, unknown>) => ({
          id: e.id as string,
          pageId: null, // remote records don't have local pages
          pageUrl: (e.pageUrl as string) ?? null,
          schemaVersion: e.schemaVersion as number,
          data: e.data as Record<string, unknown>,
          unmappedFields: (e.unmappedFields ?? []) as Record<string, unknown>[],
          metadata: (e.metadata ?? {}) as Record<string, unknown>,
          runId: runId,
        }));
        const counts = await input.adapter.extractionRepo.upsertBatch(batch);
        extractionsInserted += counts.inserted;
        extractionsUpdated += counts.updated;
        extrTotal += page.data.length;
      }

      extrBatch++;
      input.onExtractionProgress?.(extrBatch, extrTotal);

      if (!page.pagination.hasMore) break;
      extrCursor = page.pagination.nextCursor ?? null;
      await input.metaSet(`remote:${input.remoteName}:pull_cursor_extractions`, extrCursor!);
    }

    await input.metaDelete(`remote:${input.remoteName}:pull_cursor_extractions`);

    // Step 7: Pull entity sources
    let esCursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor_entity_sources`);
    if (input.restart) {
      await input.metaDelete(`remote:${input.remoteName}:pull_cursor_entity_sources`);
      esCursor = null;
    }

    while (true) {
      const page = await client.getEntitySourcesStreamPaginated(jobId, {
        cursor: esCursor ?? undefined,
        since: input.full ? undefined : since ?? undefined,
        limit: 500,
      });

      if (page.data.length > 0) {
        const batch = page.data.map((es: Record<string, unknown>) => ({
          entityId: es.entityId as string,
          extractionId: es.extractionId as string,
          matchConfidence: es.matchConfidence as number,
        }));
        entitySourcesInserted += await input.adapter.entitySourceRepo.upsertBatchSources(batch);
      }

      if (!page.pagination.hasMore) break;
      esCursor = page.pagination.nextCursor ?? null;
      await input.metaSet(`remote:${input.remoteName}:pull_cursor_entity_sources`, esCursor!);
    }

    await input.metaDelete(`remote:${input.remoteName}:pull_cursor_entity_sources`);
  }
```

- [x] **Step 4: Implement action pull phase**

```typescript
  // Step 8: Pull actions (optional)
  let actionsInserted = 0;
  let actionsUpdated = 0;

  if (input.includeActions && input.adapter.actionRepo) {
    if (input.full) {
      const runIds = await input.adapter.runRepo.findIdsBySourcePrefix(`remote:${input.remoteName}:`);
      await input.adapter.actionRepo.deleteByRunIds(runIds);
    }

    if (input.restart) {
      await input.metaDelete(`remote:${input.remoteName}:pull_cursor_actions`);
    }
    let actCursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor_actions`);
    let actBatch = 0;
    let actTotal = 0;

    while (true) {
      const page = await client.getActionsStreamPaginated(jobId, {
        cursor: actCursor ?? undefined,
        since: input.full ? undefined : since ?? undefined,
        limit: 100,
      });

      if (page.data.length > 0) {
        const batch = page.data.map((a: Record<string, unknown>) => ({
          id: a.id as string,
          type: a.type as string,
          payload: a.payload as Record<string, unknown>,
          source: a.source as string,
          status: a.status as string,
          confidence: a.confidence as number,
          reasoning: (a.reasoning as string) ?? '',
          runId: runId,
          createdAt: a.createdAt as string,
          updatedAt: (a.updatedAt as string) ?? new Date().toISOString(),
          appliedAt: (a.appliedAt as string) ?? null,
          stateChanges: (a.stateChanges as Record<string, unknown>) ?? null,
          reviewedBy: (a.reviewedBy as string) ?? null,
        }));
        const counts = await input.adapter.actionRepo.upsertBatch(batch);
        actionsInserted += counts.inserted;
        actionsUpdated += counts.updated;
        actTotal += page.data.length;
      }

      actBatch++;
      input.onActionProgress?.(actBatch, actTotal);

      if (!page.pagination.hasMore) break;
      actCursor = page.pagination.nextCursor ?? null;
      await input.metaSet(`remote:${input.remoteName}:pull_cursor_actions`, actCursor!);
    }

    await input.metaDelete(`remote:${input.remoteName}:pull_cursor_actions`);
  }
```

- [x] **Step 5: Update PullResult return value**

Add the new counts to the return object at the end of `runPullCommand`:

```typescript
  return {
    success: true,
    entitiesInserted, entitiesUpdated,
    extractionsInserted, extractionsUpdated,
    entitySourcesInserted,
    actionsInserted, actionsUpdated,
    schemaFieldsAdded, newFields,
    llmTokens, llmCostUsd,
    resumed, jobStatus,
  };
```

- [x] **Step 6: Update handlePullCommand for new flags and summary**

In `handlePullCommand`, pass the new flags and add progress callbacks:

```typescript
      includeExtractions: opts.includeExtractions,
      includeActions: opts.includeActions,
      // Wire adapter repos
      adapter: {
        ...project.adapter as unknown as PullInput['adapter'],
        extractionRepo: project.adapter.extractionRepo,
        actionRepo: project.adapter.actionRepo,
        entitySourceRepo: project.adapter.entitySourceRepo,
      },
      onExtractionProgress: (batch, total) => {
        process.stderr.write(`\r  Extractions: batch ${batch} | ${total} fetched`);
      },
      onActionProgress: (batch, total) => {
        process.stderr.write(`\r  Actions: batch ${batch} | ${total} fetched`);
      },
```

Update summary output:

```typescript
      if (result.extractionsInserted || result.extractionsUpdated) {
        console.log(`  Extractions: ${result.extractionsInserted} new, ${result.extractionsUpdated} updated`);
      }
      if (result.entitySourcesInserted) {
        console.log(`  Provenance links: ${result.entitySourcesInserted}`);
      }
      if (result.actionsInserted || result.actionsUpdated) {
        console.log(`  Actions: ${result.actionsInserted} new, ${result.actionsUpdated} updated`);
      }
```

- [x] **Step 7: Register CLI flags**

In `apps/cli/src/index.tsx`, add to pull command options:

```typescript
        .option('include-extractions', {
          type: 'boolean',
          default: false,
          describe: 'Also pull extraction records from the remote job',
        })
        .option('include-actions', {
          type: 'boolean',
          default: false,
          describe: 'Also pull action history from the remote job',
        }),
```

Pass to `handlePullCommand`:

```typescript
      await handlePullCommand({
        remoteName: argv.remote as string,
        full: argv.full,
        restart: argv.restart,
        includeExtractions: argv.includeExtractions,
        includeActions: argv.includeActions,
      });
```

- [x] **Step 8: Run all pull tests**

Run: `cd apps/cli && pnpm test -- --run pull`
Expected: ALL PASS

- [x] **Step 9: Commit**

```bash
git add apps/cli/src/commands/pull.ts apps/cli/src/index.tsx apps/cli/tests/
git commit -m "feat(cli): add --include-extractions and --include-actions flags to spatula pull"
```

---

## Task 14: ApiDataSource Status Stubs

**Files:**
- Modify: `apps/cli/src/data-sources/api-data-source.ts:74-76`
- Test: `apps/cli/tests/unit/data-sources/api-data-source.test.ts`

- [x] **Step 1: Update ApiDataSource.getStatus() to read from job stats**

In `apps/cli/src/data-sources/api-data-source.ts`:

```typescript
      pendingActions: (job.stats as Record<string, number>)?.pendingActionsCount ?? 0,
      schemaFields: (job.stats as Record<string, number>)?.schemaFieldCount ?? 0,
      storageBytes: {
        pages: (job.stats as Record<string, number>)?.storageBytesUsed ?? 0,
        database: 0,
        exports: 0,
      },
```

Remove the TODO comments.

- [x] **Step 2: Write test verifying stats are read from job response**

```typescript
it('reads pendingActions and schemaFields from job stats', async () => {
  mockClient.getJob.mockResolvedValue({
    id: 'j1', status: 'running',
    stats: { pendingActionsCount: 5, schemaFieldCount: 12, storageBytesUsed: 1024 },
  });
  const status = await dataSource.getStatus();
  expect(status.pendingActions).toBe(5);
  expect(status.schemaFields).toBe(12);
  expect(status.storageBytes.pages).toBe(1024);
});
```

- [x] **Step 3: Run tests and commit**

Run: `cd apps/cli && pnpm test -- --run api-data-source`
Expected: ALL PASS

```bash
git add apps/cli/src/data-sources/api-data-source.ts apps/cli/tests/
git commit -m "fix(cli): wire ApiDataSource status fields to job stats instead of stub zeros"
```

---

## Task 15: Roadmap Update

**Files:**
- Modify: `docs/superpowers/specs/wave-roadmap.md`

- [x] **Step 1: Update wave roadmap**

Mark Wave 5-6 as complete. Update final test counts (run `find . -name '*.test.ts' | wc -l` and test runner output).

- [x] **Step 2: Run full test suite**

Run: `pnpm test -- --run` from project root.
Verify all tests pass across all packages.

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/specs/wave-roadmap.md
git commit -m "chore: mark Wave 5-6 complete in roadmap with final test counts"
```

---

## Dependency Graph

```
Task 1 (config diff) ─────────────── independent
Task 2 (CSS tables) ──────────────── independent
Task 3 (add dedup) ───────────────── independent
Task 4 (tenant auth) ─────────────── independent
Task 5 (quota audit) ─────────────── independent
Task 6 (cost header) ─────────────── independent
Task 7 (gauges) ──────────────────── independent
Task 8 (SQLite migration) ────────── prerequisite for 11, 12, 13
Task 9 (server changes) ──────────── prerequisite for 10, 14
Task 10 (API client methods) ─────── prerequisite for 13
Task 11 (SQLite repo methods) ────── prerequisite for 12, 13
Task 12 (reset --keep-remote) ────── depends on 8, 11
Task 13 (pull flow extension) ────── depends on 8, 10, 11
Task 14 (ApiDataSource stubs) ────── depends on 9
Task 15 (roadmap update) ─────────── last
```

**Parallelizable groups:**
- Tasks 1-7: all independent, can run in any order or parallel
- Tasks 8-11: sequential within Group 1
- Tasks 12-14: can run in parallel after their dependencies
- Task 15: final

---

## Post-ship follow-ups (closed)

All 15 tasks shipped in 413ac19 and surrounding feature commits. Subsequent
defects found in retrospective superpowers review (2026-04-19) were closed:

- `9a19bc2` — composite cursor for `EntitySourceRepository.findByJobCursor`
  (single-column cursor dropped rows when an entityId's sources split across
  a page boundary)
- `a39dc2d` — within-batch dup count fix applied to extraction + action
  upsertBatch (`c1d7b1c` had only fixed entity-repository)
- `d775ef6` — error boundary around entity-sources pull loop (matching
  extraction/action loops from `733f298`)
- `51d088d` — `reset --keep-remote` deletes orphan `entity_sources` rows
  before wiping local entities/extractions
- `0d80b47` — `queue_depth` gauge wired to BullMQ
  `getJobCounts('waiting','active','delayed')` summed across all 6 queues
  via `getTotalQueueDepth()` helper in `apps/api/src/server.ts`. Per-queue
  errors tolerated so a single Redis hiccup does not zero the gauge.
- `46cf144` — Cleared three pre-existing TypeScript errors blocking
  `pnpm --filter @spatula/api build`: bullmq direct import (re-export
  `Queue/Worker/Job` from `@spatula/queue` instead), missing 403 schema
  on `triggerExportRoute`, and `JobStatus` narrowing in `registerGauges`.
- _(pending commit)_ — Root-cause fix for f101936: migrations now
  applied once via vitest `globalSetup` in `packages/db/vitest.config.ts`,
  and `runMigrations` closes its pg pool in a try/finally so setup
  doesn't leak connections.
