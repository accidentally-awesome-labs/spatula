# Wave 2.4b: Config Diff Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a config diff engine that detects changes between the current `spatula.yaml` and the last run's config snapshot, computes what work needs to happen (re-extraction, retries, reconciliation), and provides data for the user confirmation prompt.

**Architecture:** The diff engine compares two `JobConfig` objects: the current resolved config and the snapshot from the last run. It produces a `ConfigDiff` object with categorized changes (seeds, fields, crawl settings) and computed impact (pages needing re-extraction, tasks to retry). A URL normalizer ensures seed comparison handles trailing slashes, port variations, and fragment differences. Field rename detection uses a heuristic (same type, removed + added in same diff) that the caller can present as a prompt.

**Tech Stack:** TypeScript, Vitest, Zod (for type reference), `node:url` (URL parsing)

**Spec references:**

- Phase 13 spec: section 6 (Config Diff Engine, sections 6.1-6.7)
- File: `docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md`

---

## File Structure

### New Files

| File                                                     | Responsibility                                |
| -------------------------------------------------------- | --------------------------------------------- |
| `packages/core/src/config/url-normalizer.ts`             | Normalize URLs for consistent seed comparison |
| `packages/core/src/config/config-differ.ts`              | Compare two JobConfigs, produce ConfigDiff    |
| `packages/core/src/config/diff-types.ts`                 | ConfigDiff, FieldChange, DiffImpact types     |
| `packages/core/tests/unit/config/url-normalizer.test.ts` | URL normalization tests                       |
| `packages/core/tests/unit/config/config-differ.test.ts`  | Config diff tests                             |

### Modified Files

| File                                | Change          |
| ----------------------------------- | --------------- |
| `packages/core/src/config/index.ts` | Add new exports |

---

## Task 1: Diff Types

**Files:**

- Create: `packages/core/src/config/diff-types.ts`

- [ ] **Step 1: Create the diff types file**

```typescript
// packages/core/src/config/diff-types.ts
import type { FieldDefinitionOutput } from '../types/schema.js';

/**
 * Describes how a field was modified between config snapshots.
 */
export interface FieldChange {
  name: string;
  changes: Array<{
    property: string; // 'type', 'required', 'selector', 'description'
    from: unknown;
    to: unknown;
  }>;
}

/**
 * Potential field rename detected by heuristic (same type, removed + added).
 * The caller decides whether to treat as rename or as remove + add.
 *
 * Note: Spec section 6.3 calls this `fieldsRenamed`, but these are CANDIDATES
 * that require user confirmation (spec section 6.5). The CLI prompt converts
 * confirmed renames into actual field renames. Unconfirmed ones revert to
 * fieldsAdded + fieldsRemoved.
 */
export interface PotentialRename {
  from: string;
  to: string;
  type: string;
}

/**
 * Computed impact of config changes — what work needs to happen.
 */
export interface DiffImpact {
  newTasksToEnqueue: number;
  pagesNeedingReextraction: number | null; // null = needs DB query
  reextractionCostEstimate: number;
  failedTasksToRetry: number | null; // null = needs DB query
  skippedTasksToReenqueue: number | null; // null = needs DB query
  forceFullReconciliation: boolean;
}

/**
 * Full diff between two config snapshots.
 */
export interface ConfigDiff {
  hasChanges: boolean;

  // Seeds
  seedsAdded: string[];
  seedsRemoved: string[];

  // Schema fields
  fieldsAdded: FieldDefinitionOutput[];
  fieldsRemoved: string[];
  fieldsModified: FieldChange[];
  potentialRenames: PotentialRename[];
  schemaModeChanged?: { from: string; to: string };

  // Crawl settings
  crawlChanged: {
    maxDepth?: { from: number; to: number };
    maxPages?: { from: number; to: number };
    concurrency?: { from: number; to: number };
    crawlerType?: { from: string; to: string };
    proxyChanged: boolean;
    cookiesChanged: boolean;
    // Note: robotsTxtToggled is not detectable from JobConfig alone —
    // it lives in GlobalConfig.politeness.respectRobotsTxt (or SpatulaYaml.crawl).
    // The LocalPipelineRunner must detect this from the SpatulaYaml diff, not
    // from diffConfigs(). When detected, set skippedTasksToReenqueue = null.
  };

  // Other
  llmChanged: boolean;
  reconciliationChanged: boolean;
  safetyChanged: boolean;

  // Derived work
  impact: DiffImpact;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/config/diff-types.ts
git commit -m "feat(core): add config diff types for change detection"
```

---

## Task 2: URL Normalizer

**Files:**

- Create: `packages/core/src/config/url-normalizer.ts`
- Create: `packages/core/tests/unit/config/url-normalizer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/config/url-normalizer.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../../../src/config/url-normalizer.js';

describe('normalizeUrl', () => {
  it('removes trailing slashes', () => {
    expect(normalizeUrl('https://example.com/products/')).toBe('https://example.com/products');
  });

  it('preserves root path without double-slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    // Root path keeps its slash — only trailing slashes on paths are removed
  });

  it('lowercases hostname', () => {
    expect(normalizeUrl('https://Example.COM/Products')).toBe('https://example.com/Products');
    // Path case is preserved (case-sensitive)
  });

  it('sorts query parameters', () => {
    expect(normalizeUrl('https://example.com/search?z=1&a=2&m=3')).toBe(
      'https://example.com/search?a=2&m=3&z=1',
    );
  });

  it('removes default ports', () => {
    expect(normalizeUrl('https://example.com:443/page')).toBe('https://example.com/page');
    expect(normalizeUrl('http://example.com:80/page')).toBe('http://example.com/page');
  });

  it('preserves non-default ports', () => {
    expect(normalizeUrl('https://example.com:8080/page')).toBe('https://example.com:8080/page');
  });

  it('removes fragments', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('handles URLs with no path', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('handles URLs with query and fragment', () => {
    expect(normalizeUrl('https://example.com/search?q=test#results')).toBe(
      'https://example.com/search?q=test',
    );
  });

  it('normalizes identical URLs to same string', () => {
    const a = normalizeUrl('https://Example.COM/products/');
    const b = normalizeUrl('https://example.com/products');
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run url-normalizer`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement URL normalizer**

```typescript
// packages/core/src/config/url-normalizer.ts

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
};

/**
 * Normalize a URL for consistent comparison.
 * - Lowercase hostname
 * - Remove default ports (:80 for http, :443 for https)
 * - Sort query parameters
 * - Remove fragments
 * - Remove trailing slashes (except root "/")
 */
export function normalizeUrl(urlString: string): string {
  const url = new URL(urlString);

  // Lowercase hostname (URL constructor already does this, but be explicit)
  url.hostname = url.hostname.toLowerCase();

  // Remove default ports
  if (url.port === DEFAULT_PORTS[url.protocol]) {
    url.port = '';
  }

  // Sort query parameters
  const params = new URLSearchParams(url.searchParams);
  const sorted = new URLSearchParams([...params.entries()].sort());
  url.search = sorted.toString() ? `?${sorted.toString()}` : '';

  // Remove fragment
  url.hash = '';

  // Build result and remove trailing slash (but keep root "/")
  let result = url.toString();
  if (result.endsWith('/') && new URL(result).pathname !== '/') {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Compare two sets of seed URLs after normalization.
 * Returns added and removed URLs (in their original form).
 */
export function diffSeeds(
  current: string[],
  previous: string[],
): { added: string[]; removed: string[] } {
  const currentNormalized = new Map(current.map((url) => [normalizeUrl(url), url]));
  const previousNormalized = new Map(previous.map((url) => [normalizeUrl(url), url]));

  const added: string[] = [];
  const removed: string[] = [];

  for (const [norm, original] of currentNormalized) {
    if (!previousNormalized.has(norm)) {
      added.push(original);
    }
  }

  for (const [norm, original] of previousNormalized) {
    if (!currentNormalized.has(norm)) {
      removed.push(original);
    }
  }

  return { added, removed };
}
```

- [ ] **Step 4: Add test for diffSeeds**

Add `diffSeeds` to the existing import line at the top of the test file, then append the test block:

```typescript
// Update the import at the top of the file:
import { normalizeUrl, diffSeeds } from '../../../src/config/url-normalizer.js';

describe('diffSeeds', () => {
  it('detects added seeds', () => {
    const result = diffSeeds(['https://example.com', 'https://new.com'], ['https://example.com']);
    expect(result.added).toEqual(['https://new.com']);
    expect(result.removed).toEqual([]);
  });

  it('detects removed seeds', () => {
    const result = diffSeeds(['https://example.com'], ['https://example.com', 'https://old.com']);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['https://old.com']);
  });

  it('ignores normalization differences', () => {
    const result = diffSeeds(['https://example.com/products'], ['https://Example.COM/products/']);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('handles empty arrays', () => {
    expect(diffSeeds([], [])).toEqual({ added: [], removed: [] });
    expect(diffSeeds(['https://a.com'], [])).toEqual({
      added: ['https://a.com'],
      removed: [],
    });
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run url-normalizer`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/url-normalizer.ts packages/core/tests/unit/config/url-normalizer.test.ts
git commit -m "feat(core): add URL normalizer for consistent seed comparison"
```

---

## Task 3: Config Differ

**Files:**

- Create: `packages/core/src/config/config-differ.ts`
- Create: `packages/core/tests/unit/config/config-differ.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/config/config-differ.test.ts
import { describe, it, expect } from 'vitest';
import { diffConfigs } from '../../../src/config/config-differ.js';
import type { JobConfig } from '../../../src/types/job.js';

function createBaseConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    name: 'Test',
    description: 'Test crawl',
    seedUrls: ['https://example.com'],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
    schema: {
      mode: 'discovery' as const,
      userFields: [],
    },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    ...overrides,
  } as JobConfig;
}

describe('diffConfigs', () => {
  it('returns hasChanges=false for identical configs', () => {
    const config = createBaseConfig();
    const diff = diffConfigs(config, config);
    expect(diff.hasChanges).toBe(false);
  });

  it('detects added seeds', () => {
    const current = createBaseConfig({ seedUrls: ['https://example.com', 'https://new.com'] });
    const previous = createBaseConfig({ seedUrls: ['https://example.com'] });
    const diff = diffConfigs(current, previous);
    expect(diff.seedsAdded).toEqual(['https://new.com']);
    expect(diff.hasChanges).toBe(true);
  });

  it('detects removed seeds', () => {
    const current = createBaseConfig({ seedUrls: ['https://example.com'] });
    const previous = createBaseConfig({ seedUrls: ['https://example.com', 'https://old.com'] });
    const diff = diffConfigs(current, previous);
    expect(diff.seedsRemoved).toEqual(['https://old.com']);
  });

  it('detects added fields', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
          { name: 'price', type: 'currency' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsAdded).toHaveLength(1);
    expect(diff.fieldsAdded[0].name).toBe('price');
  });

  it('detects removed fields', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'title', type: 'string' as const, description: 'Title', required: false },
          { name: 'price', type: 'currency' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsRemoved).toEqual(['price']);
  });

  it('detects modified fields (type change)', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'price', type: 'string' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'price', type: 'currency' as const, description: 'Price', required: false },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.fieldsModified).toHaveLength(1);
    expect(diff.fieldsModified[0].name).toBe('price');
    expect(diff.fieldsModified[0].changes).toContainEqual({
      property: 'type',
      from: 'currency',
      to: 'string',
    });
  });

  it('detects potential field renames (same type, one removed + one added)', () => {
    const current = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          { name: 'name', type: 'string' as const, description: 'Name', required: false },
        ],
      },
    } as any);
    const previous = createBaseConfig({
      schema: {
        mode: 'hybrid' as const,
        userFields: [
          {
            name: 'product_name',
            type: 'string' as const,
            description: 'Product Name',
            required: false,
          },
        ],
      },
    } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.potentialRenames).toHaveLength(1);
    expect(diff.potentialRenames[0]).toEqual({ from: 'product_name', to: 'name', type: 'string' });
    // Matched fields are removed from added/removed lists
    expect(diff.fieldsAdded).toEqual([]);
    expect(diff.fieldsRemoved).toEqual([]);
  });

  it('detects schema mode change', () => {
    const current = createBaseConfig({ schema: { mode: 'hybrid' as const } } as any);
    const previous = createBaseConfig({ schema: { mode: 'fixed' as const } } as any);
    const diff = diffConfigs(current, previous);
    expect(diff.schemaModeChanged).toEqual({ from: 'fixed', to: 'hybrid' });
  });

  it('detects crawl setting changes', () => {
    const current = createBaseConfig({
      crawl: { maxDepth: 3, maxPages: 2000, concurrency: 10, crawlerType: 'firecrawl' as const },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.crawlChanged.maxDepth).toEqual({ from: 2, to: 3 });
    expect(diff.crawlChanged.maxPages).toEqual({ from: 1000, to: 2000 });
    expect(diff.crawlChanged.concurrency).toEqual({ from: 5, to: 10 });
    expect(diff.crawlChanged.crawlerType).toEqual({ from: 'playwright', to: 'firecrawl' });
  });

  it('detects proxy changes', () => {
    const current = createBaseConfig({
      crawl: {
        maxDepth: 2,
        maxPages: 1000,
        concurrency: 5,
        crawlerType: 'playwright' as const,
        proxy: { url: 'socks5://localhost:1080' },
      },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.crawlChanged.proxyChanged).toBe(true);
  });

  it('detects LLM model change', () => {
    const current = createBaseConfig({
      llm: { primaryModel: 'llama3.2:8b' },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.llmChanged).toBe(true);
  });

  it('detects reconciliation strategy change', () => {
    const current = createBaseConfig({
      reconciliation: {
        matchStrategy: 'fuzzy_name' as const,
        conflictResolution: 'most_complete' as const,
        fuzzyMatchThreshold: 0.85,
      },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.reconciliationChanged).toBe(true);
  });

  it('computes impact: new seeds to enqueue', () => {
    const current = createBaseConfig({ seedUrls: ['https://a.com', 'https://b.com'] });
    const previous = createBaseConfig({ seedUrls: ['https://a.com'] });
    const diff = diffConfigs(current, previous);
    expect(diff.impact.newTasksToEnqueue).toBe(1);
  });

  it('computes impact: force full reconciliation on strategy change', () => {
    const current = createBaseConfig({
      reconciliation: {
        matchStrategy: 'fuzzy_name' as const,
        conflictResolution: 'most_complete' as const,
        fuzzyMatchThreshold: 0.85,
      },
    } as any);
    const previous = createBaseConfig();
    const diff = diffConfigs(current, previous);
    expect(diff.impact.forceFullReconciliation).toBe(true);
  });

  it('returns empty diff for no fields on both sides', () => {
    const config = createBaseConfig({ schema: { mode: 'discovery' as const } } as any);
    const diff = diffConfigs(config, config);
    expect(diff.fieldsAdded).toEqual([]);
    expect(diff.fieldsRemoved).toEqual([]);
    expect(diff.fieldsModified).toEqual([]);
    expect(diff.potentialRenames).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run config-differ`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement config differ**

```typescript
// packages/core/src/config/config-differ.ts
import { diffSeeds } from './url-normalizer.js';
import type { JobConfig } from '../types/job.js';
import type { FieldDefinitionOutput } from '../types/schema.js';
import type { ConfigDiff, FieldChange, PotentialRename, DiffImpact } from './diff-types.js';

/**
 * Compare two JobConfig objects and produce a ConfigDiff.
 *
 * @param current  The config from the current spatula.yaml
 * @param previous The config snapshot from the last completed/paused run
 * @returns ConfigDiff with categorized changes and computed impact
 */
export function diffConfigs(current: JobConfig, previous: JobConfig): ConfigDiff {
  // Seeds
  const { added: seedsAdded, removed: seedsRemoved } = diffSeeds(
    current.seedUrls,
    previous.seedUrls,
  );

  // Schema fields
  const currentFields = current.schema.userFields ?? [];
  const previousFields = previous.schema.userFields ?? [];
  const {
    added: fieldsAdded,
    removed: fieldsRemoved,
    modified: fieldsModified,
    renames: potentialRenames,
  } = diffFields(currentFields, previousFields);

  // Schema mode
  const schemaModeChanged =
    current.schema.mode !== previous.schema.mode
      ? { from: previous.schema.mode, to: current.schema.mode }
      : undefined;

  // Crawl settings
  const crawlChanged = diffCrawlSettings(current, previous);

  // LLM
  const llmChanged =
    current.llm.primaryModel !== previous.llm.primaryModel ||
    JSON.stringify(current.llm.modelOverrides) !== JSON.stringify(previous.llm.modelOverrides);

  // Reconciliation
  const reconciliationChanged =
    JSON.stringify(current.reconciliation) !== JSON.stringify(previous.reconciliation);

  // Safety (compared via name/description as proxy since safetyPreset isn't in JobConfig)
  const safetyChanged = false; // Safety is not in JobConfig — always false for now

  // Check if anything changed
  const hasChanges =
    seedsAdded.length > 0 ||
    seedsRemoved.length > 0 ||
    fieldsAdded.length > 0 ||
    fieldsRemoved.length > 0 ||
    fieldsModified.length > 0 ||
    potentialRenames.length > 0 ||
    schemaModeChanged !== undefined ||
    crawlChanged.maxDepth !== undefined ||
    crawlChanged.maxPages !== undefined ||
    crawlChanged.concurrency !== undefined ||
    crawlChanged.crawlerType !== undefined ||
    crawlChanged.proxyChanged ||
    crawlChanged.cookiesChanged ||
    llmChanged ||
    reconciliationChanged;

  // Compute impact
  const impact = computeImpact({
    seedsAdded,
    fieldsAdded,
    fieldsModified,
    crawlChanged,
    reconciliationChanged,
  });

  return {
    hasChanges,
    seedsAdded,
    seedsRemoved,
    fieldsAdded,
    fieldsRemoved,
    fieldsModified,
    potentialRenames,
    schemaModeChanged,
    crawlChanged,
    llmChanged,
    reconciliationChanged,
    safetyChanged,
    impact,
  };
}

function diffFields(
  current: FieldDefinitionOutput[],
  previous: FieldDefinitionOutput[],
): {
  added: FieldDefinitionOutput[];
  removed: string[];
  modified: FieldChange[];
  renames: PotentialRename[];
} {
  const currentByName = new Map(current.map((f) => [f.name, f]));
  const previousByName = new Map(previous.map((f) => [f.name, f]));

  const added: FieldDefinitionOutput[] = [];
  const removed: string[] = [];
  const modified: FieldChange[] = [];

  // Find added and modified
  for (const [name, field] of currentByName) {
    const prev = previousByName.get(name);
    if (!prev) {
      added.push(field);
    } else {
      const changes = diffFieldProperties(field, prev);
      if (changes.length > 0) {
        modified.push({ name, changes });
      }
    }
  }

  // Find removed
  for (const name of previousByName.keys()) {
    if (!currentByName.has(name)) {
      removed.push(name);
    }
  }

  // Detect potential renames: one removed + one added with same type.
  // Built in a separate pass to avoid splice-during-iteration bugs.
  const renames: PotentialRename[] = [];
  const usedAdded = new Set<string>();
  const usedRemoved = new Set<string>();

  if (added.length > 0 && removed.length > 0) {
    for (const removedName of removed) {
      const removedField = previousByName.get(removedName)!;
      for (const addedField of added) {
        if (usedAdded.has(addedField.name)) continue;
        if (addedField.type === removedField.type) {
          renames.push({
            from: removedName,
            to: addedField.name,
            type: addedField.type,
          });
          usedAdded.add(addedField.name);
          usedRemoved.add(removedName);
          break; // One rename per removed field
        }
      }
    }

    // Filter out matched entries from added/removed
    const filteredAdded = added.filter((f) => !usedAdded.has(f.name));
    const filteredRemoved = removed.filter((n) => !usedRemoved.has(n));
    added.length = 0;
    added.push(...filteredAdded);
    removed.length = 0;
    removed.push(...filteredRemoved);
  }

  return { added, removed, modified, renames };
}

function diffFieldProperties(
  current: FieldDefinitionOutput,
  previous: FieldDefinitionOutput,
): Array<{ property: string; from: unknown; to: unknown }> {
  const changes: Array<{ property: string; from: unknown; to: unknown }> = [];

  if (current.type !== previous.type) {
    changes.push({ property: 'type', from: previous.type, to: current.type });
  }
  if (current.required !== previous.required) {
    changes.push({ property: 'required', from: previous.required, to: current.required });
  }
  if (current.description !== previous.description) {
    changes.push({ property: 'description', from: previous.description, to: current.description });
  }

  return changes;
}

function diffCrawlSettings(current: JobConfig, previous: JobConfig): ConfigDiff['crawlChanged'] {
  return {
    maxDepth:
      current.crawl.maxDepth !== previous.crawl.maxDepth
        ? { from: previous.crawl.maxDepth, to: current.crawl.maxDepth }
        : undefined,
    maxPages:
      current.crawl.maxPages !== previous.crawl.maxPages
        ? { from: previous.crawl.maxPages, to: current.crawl.maxPages }
        : undefined,
    concurrency:
      current.crawl.concurrency !== previous.crawl.concurrency
        ? { from: previous.crawl.concurrency, to: current.crawl.concurrency }
        : undefined,
    crawlerType:
      current.crawl.crawlerType !== previous.crawl.crawlerType
        ? { from: previous.crawl.crawlerType, to: current.crawl.crawlerType }
        : undefined,
    proxyChanged: JSON.stringify(current.crawl.proxy) !== JSON.stringify(previous.crawl.proxy),
    cookiesChanged:
      JSON.stringify(current.crawl.cookies) !== JSON.stringify(previous.crawl.cookies),
  };
}

function computeImpact(context: {
  seedsAdded: string[];
  fieldsAdded: FieldDefinitionOutput[];
  fieldsModified: FieldChange[];
  crawlChanged: ConfigDiff['crawlChanged'];
  reconciliationChanged: boolean;
}): DiffImpact {
  const needsReextraction =
    context.fieldsAdded.length > 0 ||
    context.fieldsModified.some(
      (f) => f.changes.some((c) => c.property === 'type'),
      // Note: 'selector' changes are not detectable here because selectors
      // are not carried through to FieldDefinitionOutput/JobConfig.
      // See design note above about selector change detection.
    );

  return {
    newTasksToEnqueue: context.seedsAdded.length,
    // null = needs DB query from caller (LocalPipelineRunner)
    // 0 = definitively no work needed
    pagesNeedingReextraction: needsReextraction ? null : 0,
    reextractionCostEstimate: 0, // Computed by caller using estimateCost()
    failedTasksToRetry:
      context.crawlChanged.proxyChanged || context.crawlChanged.cookiesChanged ? null : 0,
    skippedTasksToReenqueue: null, // Always needs DB query (robots.txt toggle detected externally)
    forceFullReconciliation: context.reconciliationChanged,
  };
}
```

**Design note:** The `impact` values that require DB queries (`pagesNeedingReextraction`, `failedTasksToRetry`, `skippedTasksToReenqueue`) use `null` to mean "needs DB query from caller." `0` means definitively no work needed. The `LocalPipelineRunner` (Phase 13 Step 4) fills in actual counts via DB queries. The diff engine itself is a pure function with no DB dependency.

**Note on `selector` changes:** `FieldDefinitionOutput` has no `selector` field — selectors are a YAML-level concept dropped during `yamlToJobConfig()`. Selector change detection is therefore not supported by `diffConfigs()` operating on `JobConfig` objects. If selector-based re-extraction is needed, the `LocalPipelineRunner` must compare raw `SpatulaYaml` objects directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run config-differ`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/config-differ.ts packages/core/tests/unit/config/config-differ.test.ts
git commit -m "feat(core): add config diff engine with field rename detection"
```

---

## Task 4: Wire Up Exports & Integration Verification

**Files:**

- Modify: `packages/core/src/config/index.ts`

- [ ] **Step 1: Update config barrel exports**

Add to `packages/core/src/config/index.ts`:

```typescript
// Config diff engine (Phase 13)
export * from './diff-types.js';
export { normalizeUrl, diffSeeds } from './url-normalizer.js';
export { diffConfigs } from './config-differ.js';
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds

- [ ] **Step 3: Run full core test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run`
Expected: All tests PASS

- [ ] **Step 4: Run queue tests (no regressions)**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/index.ts
git commit -m "feat(core): wire up config diff engine exports"
```
