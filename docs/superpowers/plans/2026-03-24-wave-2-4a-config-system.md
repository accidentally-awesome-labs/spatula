# Wave 2.4a: Config System — YAML Parser, Global Config & Resolver

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the configuration pipeline for Phase 13's project-folder model: parse `spatula.yaml` with user-friendly field names, load `~/.spatula/config.yaml` for global preferences, resolve config through a priority stack (defaults → global → project → CLI flags → env vars), and detect project roots by walking directories.

**Architecture:** The YAML parser transforms user-friendly config (`depth`, `limit`, `fields` shorthand) into the internal `JobConfig` type. The global config loader reads `~/.spatula/config.yaml` for credentials and defaults. The resolver merges all config sources in priority order. Project detection walks up directories looking for `spatula.yaml`. All components are pure functions in `@spatula/core/config/` — no side effects beyond file reads.

**Tech Stack:** TypeScript, Vitest, `yaml` (YAML parsing), Zod (validation), `node:fs` + `node:path` (file ops)

**Spec references:**
- Phase 13 spec: sections 2.1-2.7 (config structure, resolution, secrets)
- Phase 13 spec: section 6 (config diff engine — deferred to Wave 2.4b)
- File: `docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/core/src/config/yaml-parser.ts` | Parse `spatula.yaml` → `JobConfig`, handle field shorthand expansion |
| `packages/core/src/config/global-config.ts` | Load + validate `~/.spatula/config.yaml` |
| `packages/core/src/config/config-resolver.ts` | Merge config sources in priority order |
| `packages/core/src/config/project-detection.ts` | Find project root by walking up directories |
| `packages/core/src/config/types.ts` | Config types (`SpatulaYaml`, `GlobalConfig`, `ResolvedConfig`) |
| `packages/core/tests/unit/config/yaml-parser.test.ts` | YAML parser tests |
| `packages/core/tests/unit/config/global-config.test.ts` | Global config tests |
| `packages/core/tests/unit/config/config-resolver.test.ts` | Resolver tests |
| `packages/core/tests/unit/config/project-detection.test.ts` | Project detection tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/core/src/config/index.ts` | Add new exports |
| `packages/core/package.json` | Add `yaml` dependency |

---

## Task 1: Config Types & YAML Package

**Files:**
- Create: `packages/core/src/config/types.ts`
- Modify: `packages/core/package.json`

- [ ] **Step 1: Install yaml package**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core add yaml`

- [ ] **Step 2: Create config types**

```typescript
// packages/core/src/config/types.ts
import { z } from 'zod';

/**
 * User-facing spatula.yaml schema.
 * Uses simplified field names (depth, limit, fields shorthand)
 * that get transformed to internal JobConfig format by the parser.
 */

// Field shorthand: "product_name: string" or expanded { field, type, ... }
// IMPORTANT: expanded form MUST come first in the union — z.union uses first-match.
// If z.record is first, { field: 'price', type: 'currency' } matches it as a
// two-key shorthand instead of an expanded entry.
export const YamlFieldShorthand = z.union([
  // Expanded form with all options (tried FIRST)
  z.object({
    field: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']),
    required: z.boolean().optional(),
    selector: z.string().optional(),
    description: z.string().optional(),
  }),
  // Shorthand: { product_name: "string" } → single key-value pair (tried second)
  z.record(z.string(), z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object'])),
]);
export type YamlFieldShorthand = z.infer<typeof YamlFieldShorthand>;

export const SpatulaYamlSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),

  seeds: z.array(z.string().url()).min(1, 'At least one seed URL is required'),

  fields: z.array(YamlFieldShorthand).optional(),

  // Top-level shorthand for common options
  depth: z.number().min(0).max(10).optional(),
  limit: z.number().min(1).optional(),
  crawler: z.enum(['playwright', 'firecrawl']).optional(),
  safety: z.enum(['trust_ai', 'balanced', 'cautious', 'manual']).optional(),
  // Note: `safety` is NOT mapped to JobConfig (no safetyPreset field exists there).
  // It's a runtime setting consumed by the LocalPipelineRunner and action executor
  // when Phase 13 Step 4 is implemented. Stored on ResolvedConfig for later use.

  // Nested config sections
  crawl: z.object({
    concurrency: z.number().min(1).max(20).optional(),
    proxy: z.union([
      z.string().min(1),  // Bare string: "socks5://127.0.0.1:1080"
      z.object({          // Object form with optional auth
        url: z.string().min(1),
        username: z.string().optional(),
        password: z.string().optional(),
      }),
    ]).optional()
    .transform((val) => {
      if (typeof val === 'string') return { url: val };
      return val;
    }),
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string().optional(),
    })).optional(),
  }).optional(),

  schema: z.object({
    mode: z.enum(['fixed', 'discovery', 'hybrid']).optional(),
    evolution: z.object({
      batchSize: z.number().optional(),
      maxFields: z.number().optional(),
    }).optional(),
  }).optional(),

  llm: z.object({
    model: z.string().optional(),
    overrides: z.object({
      pageRelevance: z.string().optional(),
      extraction: z.string().optional(),
      linkEvaluation: z.string().optional(),
      schemaEvolution: z.string().optional(),
      entityMatching: z.string().optional(),
      conflictResolution: z.string().optional(),
      qualityAudit: z.string().optional(),
      documentation: z.string().optional(),
    }).optional(),
  }).optional(),

  reconciliation: z.object({
    strategy: z.enum(['exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted']).optional(),
    conflictResolution: z.enum(['most_common', 'most_complete', 'source_priority', 'most_recent', 'llm_resolved']).optional(),
    fuzzyThreshold: z.number().optional(),
  }).optional(),

  export: z.object({
    format: z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite']).optional(),
    autoExport: z.boolean().optional(),
    includeProvenance: z.boolean().optional(),
  }).optional(),

  // Note: notify is parsed and validated here but NOT mapped to JobConfig
  // (JobConfig has no notify field). It's consumed by the LocalPipelineRunner
  // in Phase 13 Step 4. Stored on SpatulaYaml for later use.
  notify: z.object({
    desktop: z.boolean().optional(),
    webhook: z.string().url().optional(),
    on: z.array(z.enum(['completed', 'failed', 'cancelled', 'action_pending'])).optional(),
  }).optional(),
}).strict();

export type SpatulaYaml = z.infer<typeof SpatulaYamlSchema>;

/**
 * Global config at ~/.spatula/config.yaml
 */
export const GlobalConfigSchema = z.object({
  version: z.number().default(1),

  // Credentials
  openrouterApiKey: z.string().optional(),
  firecrawlApiKey: z.string().optional(),

  // LLM preferences
  llm: z.object({
    provider: z.enum(['openrouter', 'ollama']).optional(),
    model: z.string().optional(),
  }).optional(),

  // Crawler preference
  crawler: z.enum(['playwright', 'firecrawl']).optional(),

  // Politeness defaults
  politeness: z.object({
    respectRobotsTxt: z.boolean().optional(),
    delayMs: z.number().optional(),
  }).optional(),

  // Remote server connections
  remotes: z.record(z.string(), z.object({
    url: z.string().url(),
    apiKey: z.string().optional(),
  })).optional(),
}).passthrough();  // passthrough (not strict) — preserve unknown keys for forward-compat
// Newer Spatula versions may add keys that older versions should ignore, not reject.

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * CLI flag overrides
 */
export interface CliFlags {
  depth?: number;
  limit?: number;
  crawler?: 'playwright' | 'firecrawl';
  model?: string;
  concurrency?: number;
}

/**
 * Fully resolved config — ready to convert to JobConfig
 */
export interface ResolvedConfig {
  projectYaml: SpatulaYaml;
  globalConfig: GlobalConfig | null;
  cliFlags: CliFlags;
  projectRoot: string;
}
```

- [ ] **Step 3: Update config barrel exports**

In `packages/core/src/config/index.ts`, add the new exports (keep existing exports):

```typescript
// Existing
export { DefaultConfigExecutor } from './config-executor.js';

// New — project-folder config system
export * from './types.js';
export { parseProjectYaml, expandFieldShorthand } from './yaml-parser.js';
export { loadGlobalConfig, getGlobalConfigPath } from './global-config.js';
export { yamlToJobConfig } from './config-resolver.js';
export type { YamlToJobConfigOptions } from './config-resolver.js';
export { findProjectRoot } from './project-detection.js';
```

Note: This will fail to compile until the other files are created. That's expected.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/types.ts packages/core/src/config/index.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): add config types and yaml dependency for project-folder model"
```

---

## Task 2: YAML Parser

**Files:**
- Create: `packages/core/src/config/yaml-parser.ts`
- Create: `packages/core/tests/unit/config/yaml-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/config/yaml-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseProjectYaml, expandFieldShorthand } from '../../../src/config/yaml-parser.js';

describe('expandFieldShorthand', () => {
  it('expands shorthand "name: type" to full field definition', () => {
    const input = { product_name: 'string' };
    const result = expandFieldShorthand(input);
    expect(result).toEqual({
      name: 'product_name',
      type: 'string',
      description: 'product_name',
      required: false,
    });
  });

  it('passes through expanded form with field key', () => {
    const input = { field: 'price', type: 'currency', required: true, selector: '.price' };
    const result = expandFieldShorthand(input);
    expect(result).toEqual({
      name: 'price',
      type: 'currency',
      description: 'price',
      required: true,
    });
  });

  it('uses description from expanded form if provided', () => {
    const input = { field: 'title', type: 'string', description: 'Product title' };
    const result = expandFieldShorthand(input);
    expect(result.description).toBe('Product title');
  });
});

describe('parseProjectYaml', () => {
  it('parses minimal config (seeds only)', () => {
    const yaml = `
seeds:
  - https://example.com/products
`;
    const result = parseProjectYaml(yaml);
    expect(result.seeds).toEqual(['https://example.com/products']);
  });

  it('parses tier 2 config with field shorthand', () => {
    const yaml = `
name: Acme Products
seeds:
  - https://acme.com/products
fields:
  - product_name: string
  - price: currency
depth: 3
limit: 2000
`;
    const result = parseProjectYaml(yaml);
    expect(result.name).toBe('Acme Products');
    expect(result.seeds).toHaveLength(1);
    expect(result.fields).toHaveLength(2);
    expect(result.depth).toBe(3);
    expect(result.limit).toBe(2000);
  });

  it('parses tier 3 config with nested sections', () => {
    const yaml = `
name: Full Config
seeds:
  - https://example.com
fields:
  - field: price
    type: currency
    required: true
    selector: ".price-current"
depth: 3
limit: 2000
crawler: playwright
safety: balanced
crawl:
  concurrency: 5
  proxy:
    url: socks5://127.0.0.1:1080
schema:
  mode: hybrid
  evolution:
    batchSize: 10
llm:
  model: anthropic/claude-sonnet-4-20250514
  overrides:
    linkEvaluation: anthropic/claude-3-haiku-20240307
reconciliation:
  strategy: composite_key
export:
  format: json
  autoExport: true
`;
    const result = parseProjectYaml(yaml);
    expect(result.name).toBe('Full Config');
    expect(result.crawler).toBe('playwright');
    expect(result.safety).toBe('balanced');
    expect(result.crawl?.concurrency).toBe(5);
    expect(result.crawl?.proxy?.url).toBe('socks5://127.0.0.1:1080');
    expect(result.schema?.mode).toBe('hybrid');
    expect(result.schema?.evolution?.batchSize).toBe(10);
    expect(result.llm?.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.reconciliation?.strategy).toBe('composite_key');
    expect(result.export?.format).toBe('json');
    expect(result.export?.autoExport).toBe(true);
  });

  it('throws ValidationError on missing seeds', () => {
    const yaml = `
name: No Seeds
`;
    expect(() => parseProjectYaml(yaml)).toThrow('seeds');
  });

  it('throws ValidationError on invalid seed URL', () => {
    const yaml = `
seeds:
  - not-a-url
`;
    expect(() => parseProjectYaml(yaml)).toThrow();
  });

  it('throws on unknown top-level keys (strict mode)', () => {
    const yaml = `
seeds:
  - https://example.com
unknown_key: value
`;
    expect(() => parseProjectYaml(yaml)).toThrow();
  });

  it('handles mixed field formats (shorthand + expanded)', () => {
    const yaml = `
seeds:
  - https://example.com
fields:
  - product_name: string
  - field: price
    type: currency
    required: true
`;
    const result = parseProjectYaml(yaml);
    expect(result.fields).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run yaml-parser`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement YAML parser**

```typescript
// packages/core/src/config/yaml-parser.ts
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ValidationError } from '@spatula/shared';
import { SpatulaYamlSchema } from './types.js';
import type { SpatulaYaml, YamlFieldShorthand } from './types.js';
import type { FieldDefinitionInput } from '../types/schema.js';

/**
 * Expand a field shorthand entry into a full FieldDefinition.
 *
 * Shorthand: { product_name: "string" } → { name, type, description, required }
 * Expanded:  { field: "price", type: "currency", required: true } → { name, type, description, required }
 */
export function expandFieldShorthand(entry: YamlFieldShorthand): FieldDefinitionInput {
  // Expanded form: has 'field' key
  if ('field' in entry && typeof entry.field === 'string') {
    return {
      name: entry.field,
      type: entry.type,
      description: entry.description ?? entry.field,
      required: entry.required ?? false,
    };
  }

  // Shorthand form: single key-value pair like { product_name: "string" }
  const keys = Object.keys(entry);
  if (keys.length === 1) {
    const name = keys[0];
    const type = (entry as Record<string, string>)[name];
    return {
      name,
      type: type as FieldDefinitionInput['type'],
      description: name,
      required: false,
    };
  }

  throw new ValidationError(`Invalid field definition: ${JSON.stringify(entry)}`);
}

/**
 * Parse a spatula.yaml string into a validated SpatulaYaml object.
 * Throws ValidationError on invalid config.
 */
export function parseProjectYaml(content: string): SpatulaYaml {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new ValidationError(`Invalid YAML syntax: ${(err as Error).message}`);
  }

  if (raw === null || raw === undefined) {
    throw new ValidationError('Empty spatula.yaml file');
  }

  const result = SpatulaYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(`Invalid spatula.yaml: ${issues}`);
  }

  return result.data;
}

/**
 * Parse a spatula.yaml file from disk.
 */
export function parseProjectYamlFile(filePath: string): SpatulaYaml {
  const content = readFileSync(filePath, 'utf-8');
  return parseProjectYaml(content);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run yaml-parser`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/yaml-parser.ts packages/core/tests/unit/config/yaml-parser.test.ts
git commit -m "feat(core): add spatula.yaml parser with field shorthand expansion"
```

---

## Task 3: Global Config Loader

**Files:**
- Create: `packages/core/src/config/global-config.ts`
- Create: `packages/core/tests/unit/config/global-config.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/config/global-config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadGlobalConfig, getGlobalConfigPath } from '../../../src/config/global-config.js';
import type { GlobalConfig } from '../../../src/config/types.js';

// Mock fs module
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

// Mock os module
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

describe('getGlobalConfigPath', () => {
  beforeEach(() => {
    delete process.env.SPATULA_HOME;
  });

  it('returns ~/.spatula/config.yaml by default', () => {
    const path = getGlobalConfigPath();
    expect(path).toBe('/home/testuser/.spatula/config.yaml');
  });

  it('respects SPATULA_HOME env var', () => {
    process.env.SPATULA_HOME = '/custom/spatula';
    const path = getGlobalConfigPath();
    expect(path).toBe('/custom/spatula/config.yaml');
  });
});

describe('loadGlobalConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SPATULA_HOME;
  });

  it('returns null when config file does not exist', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(false);

    const config = loadGlobalConfig();
    expect(config).toBeNull();
  });

  it('parses valid global config', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(`
version: 1
openrouterApiKey: sk_or_test123
llm:
  provider: ollama
  model: llama3.2:8b
crawler: playwright
politeness:
  respectRobotsTxt: true
  delayMs: 1000
`);

    const config = loadGlobalConfig();
    expect(config).not.toBeNull();
    expect(config!.openrouterApiKey).toBe('sk_or_test123');
    expect(config!.llm?.provider).toBe('ollama');
    expect(config!.llm?.model).toBe('llama3.2:8b');
    expect(config!.crawler).toBe('playwright');
    expect(config!.politeness?.delayMs).toBe(1000);
  });

  it('returns config with defaults when file is minimal', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('version: 1');

    const config = loadGlobalConfig();
    expect(config).not.toBeNull();
    expect(config!.version).toBe(1);
  });

  it('parses remotes config', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(`
version: 1
remotes:
  prod:
    url: https://api.spatula.dev
    apiKey: sk_live_abc
  staging:
    url: https://staging.spatula.dev
`);

    const config = loadGlobalConfig();
    expect(config!.remotes?.prod?.url).toBe('https://api.spatula.dev');
    expect(config!.remotes?.prod?.apiKey).toBe('sk_live_abc');
    expect(config!.remotes?.staging?.url).toBe('https://staging.spatula.dev');
  });

  it('throws on invalid YAML', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('{{invalid yaml');

    expect(() => loadGlobalConfig()).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run global-config`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement global config loader**

```typescript
// packages/core/src/config/global-config.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { ValidationError } from '@spatula/shared';
import { GlobalConfigSchema } from './types.js';
import type { GlobalConfig } from './types.js';

/**
 * Get the path to the global config file.
 * Respects SPATULA_HOME env var, defaults to ~/.spatula/config.yaml.
 */
export function getGlobalConfigPath(): string {
  const home = process.env.SPATULA_HOME ?? join(homedir(), '.spatula');
  return join(home, 'config.yaml');
}

/**
 * Load global config from ~/.spatula/config.yaml.
 * Returns null if the file does not exist.
 * Throws ValidationError on invalid content.
 */
export function loadGlobalConfig(configPath?: string): GlobalConfig | null {
  const path = configPath ?? getGlobalConfigPath();

  if (!existsSync(path)) {
    return null;
  }

  const content = readFileSync(path, 'utf-8');

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new ValidationError(`Invalid YAML in global config: ${(err as Error).message}`);
  }

  if (raw === null || raw === undefined) {
    return { version: 1 };
  }

  const result = GlobalConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(`Invalid global config: ${issues}`);
  }

  return result.data;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run global-config`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/global-config.ts packages/core/tests/unit/config/global-config.test.ts
git commit -m "feat(core): add global config loader for ~/.spatula/config.yaml"
```

---

## Task 4: Config Resolver

**Files:**
- Create: `packages/core/src/config/config-resolver.ts`
- Create: `packages/core/tests/unit/config/config-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/config/config-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { yamlToJobConfig } from '../../../src/config/config-resolver.js';
import type { SpatulaYaml } from '../../../src/config/types.js';
import type { GlobalConfig } from '../../../src/config/types.js';

const minimalYaml: SpatulaYaml = {
  seeds: ['https://example.com/products'],
};

describe('yamlToJobConfig', () => {
  it('converts minimal YAML to valid JobConfig', () => {
    const result = yamlToJobConfig(minimalYaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test/project',
    });

    expect(result.tenantId).toBe('00000000-0000-0000-0000-000000000001');
    expect(result.seedUrls).toEqual(['https://example.com/products']);
    expect(result.name).toBeDefined(); // defaults to directory name
    expect(result.description).toBeDefined();
    expect(result.crawl.maxDepth).toBe(2); // default
    expect(result.crawl.maxPages).toBe(1000); // default
    expect(result.schema.mode).toBe('discovery'); // default
  });

  it('maps user-friendly field names to internal names', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      depth: 3,
      limit: 500,
      crawler: 'firecrawl',
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test/project',
    });

    expect(result.crawl.maxDepth).toBe(3);
    expect(result.crawl.maxPages).toBe(500);
    expect(result.crawl.crawlerType).toBe('firecrawl');
  });

  it('expands field shorthand to FieldDefinition', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      fields: [
        { product_name: 'string' },
        { field: 'price', type: 'currency', required: true },
      ],
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });

    expect(result.schema.userFields).toHaveLength(2);
    expect(result.schema.userFields![0].name).toBe('product_name');
    expect(result.schema.userFields![0].type).toBe('string');
    expect(result.schema.userFields![1].name).toBe('price');
    expect(result.schema.userFields![1].required).toBe(true);
  });

  it('maps nested config sections correctly', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      schema: { mode: 'hybrid', evolution: { batchSize: 20 } },
      llm: { model: 'llama3.2:8b', overrides: { linkEvaluation: 'llama3.2:3b' } },
      reconciliation: { strategy: 'fuzzy_name', fuzzyThreshold: 0.9 },
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });

    expect(result.schema.mode).toBe('hybrid');
    expect(result.schema.evolutionConfig?.batchSize).toBe(20);
    expect(result.llm.primaryModel).toBe('llama3.2:8b');
    expect(result.llm.modelOverrides?.linkEvaluation).toBe('llama3.2:3b');
    expect(result.reconciliation?.matchStrategy).toBe('fuzzy_name');
    expect(result.reconciliation?.fuzzyMatchThreshold).toBe(0.9);
  });

  it('applies global config defaults when project config omits values', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
    };

    const globalConfig: GlobalConfig = {
      version: 1,
      llm: { provider: 'ollama', model: 'llama3.2:8b' },
      crawler: 'firecrawl',
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
      globalConfig,
    });

    expect(result.llm.primaryModel).toBe('llama3.2:8b');
    expect(result.crawl.crawlerType).toBe('firecrawl');
  });

  it('project config overrides global config', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      crawler: 'playwright',
      llm: { model: 'anthropic/claude-sonnet-4-20250514' },
    };

    const globalConfig: GlobalConfig = {
      version: 1,
      crawler: 'firecrawl',
      llm: { model: 'llama3.2:8b' },
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
      globalConfig,
    });

    expect(result.crawl.crawlerType).toBe('playwright');
    expect(result.llm.primaryModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('applies CLI flag overrides over project config', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      depth: 3,
      limit: 2000,
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
      cliFlags: { depth: 1, limit: 100 },
    });

    expect(result.crawl.maxDepth).toBe(1);
    expect(result.crawl.maxPages).toBe(100);
  });

  it('defaults schema mode to discovery when no fields provided', () => {
    const result = yamlToJobConfig(minimalYaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });
    expect(result.schema.mode).toBe('discovery');
  });

  it('defaults schema mode to hybrid when fields are provided', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      fields: [{ product_name: 'string' }],
    };
    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });
    expect(result.schema.mode).toBe('hybrid');
  });

  it('derives name from project root directory when not specified', () => {
    const result = yamlToJobConfig(minimalYaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/home/user/projects/acme-scraper',
    });
    expect(result.name).toBe('acme-scraper');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run config-resolver`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement config resolver**

```typescript
// packages/core/src/config/config-resolver.ts
import { basename } from 'node:path';
import { expandFieldShorthand } from './yaml-parser.js';
import type { SpatulaYaml, GlobalConfig, CliFlags } from './types.js';
import type { JobConfig } from '../types/job.js';
import type { FieldDefinitionInput } from '../types/schema.js';

export interface YamlToJobConfigOptions {
  tenantId: string;
  projectId: string;
  projectRoot: string;
  globalConfig?: GlobalConfig | null;
  cliFlags?: CliFlags;
}

/**
 * Convert a parsed SpatulaYaml + optional global config + optional CLI flags
 * into a fully resolved JobConfig.
 *
 * Resolution order (highest priority wins):
 *   Built-in defaults → Global config → Project YAML → CLI flags
 */
export function yamlToJobConfig(
  yaml: SpatulaYaml,
  options: YamlToJobConfigOptions,
): JobConfig {
  const { tenantId, projectRoot, globalConfig, cliFlags } = options;

  // Resolve crawler type: CLI > project > global > default
  const crawlerType =
    cliFlags?.crawler ??
    yaml.crawler ??
    globalConfig?.crawler ??
    'playwright';

  // Resolve LLM model: CLI > project > global > default
  const primaryModel =
    cliFlags?.model ??
    yaml.llm?.model ??
    globalConfig?.llm?.model ??
    'anthropic/claude-sonnet-4-20250514';

  // Resolve depth/limit: CLI > project > default
  const maxDepth = cliFlags?.depth ?? yaml.depth ?? 2;
  const maxPages = cliFlags?.limit ?? yaml.limit ?? 1000;
  const concurrency = cliFlags?.concurrency ?? yaml.crawl?.concurrency ?? 5;

  // Expand field shorthand
  const userFields: FieldDefinitionInput[] | undefined = yaml.fields?.map(expandFieldShorthand);

  // Determine schema mode: explicit > inferred from fields
  const schemaMode = yaml.schema?.mode ?? (userFields?.length ? 'hybrid' : 'discovery');

  // Derive name from project root if not specified
  const name = yaml.name ?? basename(projectRoot);
  const description = yaml.description ?? `Crawl data from ${yaml.seeds[0]}`;

  const config: JobConfig = {
    tenantId,
    name,
    description,
    seedUrls: yaml.seeds,
    crawl: {
      maxDepth,
      maxPages,
      concurrency,
      crawlerType,
      proxy: yaml.crawl?.proxy,
      cookies: yaml.crawl?.cookies,
    },
    schema: {
      mode: schemaMode,
      userFields,
      evolutionConfig: yaml.schema?.evolution
        ? {
            enabled: true,
            batchSize: yaml.schema.evolution.batchSize ?? 10,
            maxFields: yaml.schema.evolution.maxFields ?? 50,
            tableStrategy: 'auto' as const,
            relevanceThresholds: {
              requiredMin: 0.85,
              optionalMin: 0.4,
              rareBelow: 0.4,
              minCategorySampleSize: 5,
            },
          }
        : undefined,
    },
    llm: {
      primaryModel,
      modelOverrides: yaml.llm?.overrides,
    },
    reconciliation: yaml.reconciliation
      ? {
          matchStrategy: yaml.reconciliation.strategy ?? 'composite_key',
          conflictResolution: yaml.reconciliation.conflictResolution ?? 'most_complete',
          fuzzyMatchThreshold: yaml.reconciliation.fuzzyThreshold ?? 0.85,
        }
      : undefined,
  };

  return config;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run config-resolver`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/config-resolver.ts packages/core/tests/unit/config/config-resolver.test.ts
git commit -m "feat(core): add config resolver merging global, project, and CLI sources"
```

---

## Task 5: Project Detection

**Files:**
- Create: `packages/core/src/config/project-detection.ts`
- Create: `packages/core/tests/unit/config/project-detection.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/config/project-detection.test.ts
import { describe, it, expect, vi } from 'vitest';
import { findProjectRoot } from '../../../src/config/project-detection.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

describe('findProjectRoot', () => {
  it('returns directory containing spatula.yaml', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockImplementation((p: string) => {
      return p === '/home/user/projects/my-project/spatula.yaml';
    });

    const result = findProjectRoot('/home/user/projects/my-project');
    expect(result).toBe('/home/user/projects/my-project');
  });

  it('walks up directories to find spatula.yaml', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockImplementation((p: string) => {
      return p === '/home/user/projects/spatula.yaml';
    });

    const result = findProjectRoot('/home/user/projects/subdir/deep');
    expect(result).toBe('/home/user/projects');
  });

  it('returns null when no spatula.yaml found up to root', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(false);

    const result = findProjectRoot('/home/user/projects');
    expect(result).toBeNull();
  });

  it('stops at filesystem root', async () => {
    const fs = await import('node:fs');
    const calls: string[] = [];
    (fs.existsSync as any).mockImplementation((p: string) => {
      calls.push(p);
      return false;
    });

    findProjectRoot('/a/b/c');
    // Should check /a/b/c, /a/b, /a, / and stop
    expect(calls.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Implement project detection**

```typescript
// packages/core/src/config/project-detection.ts
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const PROJECT_FILE = 'spatula.yaml';

/**
 * Walk up the directory tree from startDir looking for spatula.yaml.
 * Returns the directory containing the file, or null if not found.
 */
export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, PROJECT_FILE);
    if (existsSync(candidate)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run project-detection`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/project-detection.ts packages/core/tests/unit/config/project-detection.test.ts
git commit -m "feat(core): add project root detection by walking up for spatula.yaml"
```

---

## Task 6: Wire Up Exports & Integration Verification

**Files:**
- Modify: `packages/core/src/config/index.ts`

- [ ] **Step 1: Update config barrel exports**

Replace the entire `packages/core/src/config/index.ts` with:

```typescript
// Existing
export { DefaultConfigExecutor } from './config-executor.js';

// Project-folder config system (Phase 13)
export * from './types.js';
export { parseProjectYaml, expandFieldShorthand } from './yaml-parser.js';
export { loadGlobalConfig, getGlobalConfigPath } from './global-config.js';
export { yamlToJobConfig } from './config-resolver.js';
export type { YamlToJobConfigOptions } from './config-resolver.js';
export { findProjectRoot } from './project-detection.js';
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds

- [ ] **Step 3: Run full core test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run`
Expected: All tests PASS

- [ ] **Step 4: Run queue tests (ensure no regressions)**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/index.ts
git commit -m "feat(core): wire up config system exports for project-folder model"
```
