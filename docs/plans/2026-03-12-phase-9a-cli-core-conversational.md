# Phase 9a: CLI Core + Conversational Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Ink-based CLI application with conversational job creation — users describe crawls in natural language, the LLM produces ConfigActions, and the evolving config is displayed interactively until the user confirms and starts the job.

**Architecture:** The CLI is a pure API consumer. It imports types and the LLM client from `@spatula/core`, uses HTTP to call the Phase 8 API for job CRUD, and manages local state with Zustand. The conversational mode calls OpenRouter directly to interpret user messages into ConfigActions, which are applied locally to build a JobConfig. Components are React/Ink (JSX) with `ink-testing-library` for testing.

**Tech Stack:** Ink 5 (React 18 for terminals), Zustand 5 (state), yargs 17 (CLI parsing), OpenRouter via `@spatula/core` LLM client, vitest + ink-testing-library

---

## Task 1: Project Setup — Dependencies, JSX Config, Vitest

**Files:**

- Modify: `apps/cli/package.json`
- Modify: `apps/cli/tsconfig.json`
- Create: `apps/cli/vitest.config.ts`
- Rename: `apps/cli/src/index.ts` → `apps/cli/src/index.tsx`

**Step 1: Update package.json with all dependencies**

Replace `apps/cli/package.json` with:

```json
{
  "name": "@spatula/cli",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": {
    "spatula": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.tsx",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@spatula/core": "workspace:*",
    "@spatula/shared": "workspace:*",
    "ink": "^5.1.0",
    "ink-spinner": "^5.0.0",
    "ink-text-input": "^6.0.0",
    "react": "^18.3.1",
    "yargs": "^17.7.2",
    "zustand": "^5.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^25.3.5",
    "@types/react": "^18.3.18",
    "ink-testing-library": "^4.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

**Step 2: Update tsconfig.json for JSX support**

Replace `apps/cli/tsconfig.json` with:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  },
  "include": ["src"]
}
```

**Step 3: Create vitest config**

Create `apps/cli/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
  },
});
```

**Step 4: Rename index.ts to index.tsx and add placeholder**

Rename `apps/cli/src/index.ts` to `apps/cli/src/index.tsx` with content:

```tsx
#!/usr/bin/env node
// Phase 9a: CLI Core + Conversational Mode
export {};
```

**Step 5: Install dependencies and verify build**

```bash
cd apps/cli && pnpm install
pnpm build
```

Expected: Build succeeds with no errors.

**Step 6: Verify vitest runs (no tests yet)**

```bash
cd apps/cli && pnpm test
```

Expected: "No test files found" (clean exit, no errors).

**Step 7: Commit**

```bash
git add apps/cli/package.json apps/cli/tsconfig.json apps/cli/vitest.config.ts apps/cli/src/index.tsx
git rm apps/cli/src/index.ts 2>/dev/null || true
git commit -m "feat(cli): add Ink, React, Zustand, yargs dependencies and JSX config"
```

---

## Task 2: ConfigExecutor Implementation (in core)

The `ConfigExecutor` interface is defined in `packages/core/src/interfaces/config-executor.ts` but has no implementation. The CLI needs it to apply ConfigActions to a JobConfig.

**Files:**

- Create: `packages/core/src/config/config-executor.ts`
- Create: `packages/core/src/config/index.ts`
- Modify: `packages/core/src/index.ts` (add export)
- Test: `packages/core/tests/unit/config/config-executor.test.ts`

**Step 1: Write the failing tests**

Create `packages/core/tests/unit/config/config-executor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DefaultConfigExecutor } from '../../../src/config/config-executor.js';
import type { JobConfig } from '../../../src/types/job.js';
import type { ConfigAction } from '../../../src/types/config-actions.js';
import { randomUUID } from 'crypto';

function baseConfig(): JobConfig {
  return {
    tenantId: randomUUID(),
    name: '',
    description: '',
    seedUrls: [],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
  };
}

function action(type: string, payload: Record<string, unknown>): ConfigAction {
  return { id: randomUUID(), type, reasoning: 'test', payload } as ConfigAction;
}

describe('DefaultConfigExecutor', () => {
  const executor = new DefaultConfigExecutor();

  describe('apply — metadata', () => {
    it('applies set_job_name', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_job_name', { name: 'Audiophile Products' }),
      );
      expect(result.name).toBe('Audiophile Products');
    });

    it('applies set_job_description', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_job_description', { description: 'Crawl headphones' }),
      );
      expect(result.description).toBe('Crawl headphones');
    });
  });

  describe('apply — seed URLs', () => {
    it('applies add_seed_urls', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('add_seed_urls', {
          urls: [{ url: 'https://headfi.org' }, { url: 'https://canjam.org' }],
        }),
      );
      expect(result.seedUrls).toEqual(['https://headfi.org', 'https://canjam.org']);
    });

    it('applies add_seed_urls to existing list without duplicates', () => {
      const config = { ...baseConfig(), seedUrls: ['https://headfi.org'] };
      const result = executor.apply(
        config,
        action('add_seed_urls', {
          urls: [{ url: 'https://headfi.org' }, { url: 'https://canjam.org' }],
        }),
      );
      expect(result.seedUrls).toEqual(['https://headfi.org', 'https://canjam.org']);
    });

    it('applies remove_seed_urls', () => {
      const config = {
        ...baseConfig(),
        seedUrls: ['https://a.com', 'https://b.com', 'https://c.com'],
      };
      const result = executor.apply(
        config,
        action('remove_seed_urls', { urls: ['https://b.com'] }),
      );
      expect(result.seedUrls).toEqual(['https://a.com', 'https://c.com']);
    });

    it('applies replace_seed_urls', () => {
      const config = { ...baseConfig(), seedUrls: ['https://old.com'] };
      const result = executor.apply(
        config,
        action('replace_seed_urls', {
          urls: [{ url: 'https://new.com' }],
        }),
      );
      expect(result.seedUrls).toEqual(['https://new.com']);
    });
  });

  describe('apply — crawl settings', () => {
    it('applies set_crawl_depth', () => {
      const config = baseConfig();
      const result = executor.apply(config, action('set_crawl_depth', { maxDepth: 5 }));
      expect(result.crawl.maxDepth).toBe(5);
    });

    it('applies set_max_pages', () => {
      const config = baseConfig();
      const result = executor.apply(config, action('set_max_pages', { maxPages: 500 }));
      expect(result.crawl.maxPages).toBe(500);
    });

    it('applies set_concurrency', () => {
      const config = baseConfig();
      const result = executor.apply(config, action('set_concurrency', { concurrency: 10 }));
      expect(result.crawl.concurrency).toBe(10);
    });

    it('applies set_crawler_type', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_crawler_type', { crawlerType: 'firecrawl' }),
      );
      expect(result.crawl.crawlerType).toBe('firecrawl');
    });
  });

  describe('apply — schema fields', () => {
    it('applies add_user_field', () => {
      const config = { ...baseConfig(), schema: { mode: 'fixed' as const, userFields: [] } };
      const result = executor.apply(
        config,
        action('add_user_field', {
          field: { name: 'price', description: 'Product price', type: 'currency', required: true },
          position: 'last',
        }),
      );
      expect(result.schema.userFields).toHaveLength(1);
      expect(result.schema.userFields![0].name).toBe('price');
    });

    it('applies add_multiple_user_fields', () => {
      const config = { ...baseConfig(), schema: { mode: 'fixed' as const, userFields: [] } };
      const result = executor.apply(
        config,
        action('add_multiple_user_fields', {
          fields: [
            { name: 'price', description: 'Price', type: 'currency', required: true },
            { name: 'brand', description: 'Brand', type: 'string', required: false },
          ],
        }),
      );
      expect(result.schema.userFields).toHaveLength(2);
    });

    it('applies remove_user_field', () => {
      const config = {
        ...baseConfig(),
        schema: {
          mode: 'fixed' as const,
          userFields: [
            { name: 'price', description: 'Price', type: 'currency' as const, required: true },
            { name: 'brand', description: 'Brand', type: 'string' as const, required: false },
          ],
        },
      };
      const result = executor.apply(config, action('remove_user_field', { fieldName: 'price' }));
      expect(result.schema.userFields).toHaveLength(1);
      expect(result.schema.userFields![0].name).toBe('brand');
    });

    it('applies replace_all_user_fields', () => {
      const config = {
        ...baseConfig(),
        schema: {
          mode: 'fixed' as const,
          userFields: [
            { name: 'old', description: 'Old', type: 'string' as const, required: false },
          ],
        },
      };
      const result = executor.apply(
        config,
        action('replace_all_user_fields', {
          fields: [{ name: 'new', description: 'New', type: 'number' as const, required: true }],
        }),
      );
      expect(result.schema.userFields).toHaveLength(1);
      expect(result.schema.userFields![0].name).toBe('new');
    });
  });

  describe('apply — schema mode', () => {
    it('applies set_schema_mode', () => {
      const config = baseConfig();
      const result = executor.apply(config, action('set_schema_mode', { mode: 'hybrid' }));
      expect(result.schema.mode).toBe('hybrid');
    });

    it('applies set_evolution_config', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_evolution_config', { enabled: true, batchSize: 20 }),
      );
      expect(result.schema.evolutionConfig?.enabled).toBe(true);
      expect(result.schema.evolutionConfig?.batchSize).toBe(20);
    });
  });

  describe('apply — LLM config', () => {
    it('applies set_primary_model', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_primary_model', { model: 'openai/gpt-4o' }),
      );
      expect(result.llm.primaryModel).toBe('openai/gpt-4o');
    });

    it('applies set_model_override', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_model_override', { task: 'extraction', model: 'openai/gpt-4o-mini' }),
      );
      expect(result.llm.modelOverrides?.extraction).toBe('openai/gpt-4o-mini');
    });

    it('applies clear_model_override', () => {
      const config = {
        ...baseConfig(),
        llm: {
          primaryModel: 'anthropic/claude-sonnet-4-20250514',
          modelOverrides: { extraction: 'openai/gpt-4o-mini' },
        },
      };
      const result = executor.apply(config, action('clear_model_override', { task: 'extraction' }));
      expect(result.llm.modelOverrides?.extraction).toBeUndefined();
    });
  });

  describe('apply — reconciliation', () => {
    it('applies set_match_strategy', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_match_strategy', {
          matchStrategy: 'fuzzy_name',
          fuzzyMatchThreshold: 0.9,
        }),
      );
      expect(result.reconciliation?.matchStrategy).toBe('fuzzy_name');
      expect(result.reconciliation?.fuzzyMatchThreshold).toBe(0.9);
    });

    it('applies set_conflict_resolution', () => {
      const config = baseConfig();
      const result = executor.apply(
        config,
        action('set_conflict_resolution', { strategy: 'source_priority' }),
      );
      expect(result.reconciliation?.conflictResolution).toBe('source_priority');
    });
  });

  describe('apply — control', () => {
    it('applies reset_config fully', () => {
      const config = {
        ...baseConfig(),
        name: 'Existing',
        seedUrls: ['https://a.com'],
      };
      const result = executor.apply(config, action('reset_config', {}));
      expect(result.name).toBe('');
      expect(result.seedUrls).toEqual([]);
    });

    it('applies reset_config keeping specified fields', () => {
      const config = {
        ...baseConfig(),
        name: 'Keep Me',
        description: 'Drop Me',
        seedUrls: ['https://a.com'],
      };
      const result = executor.apply(config, action('reset_config', { keepFields: ['name'] }));
      expect(result.name).toBe('Keep Me');
      expect(result.description).toBe('');
      expect(result.seedUrls).toEqual([]);
    });
  });

  describe('applyBatch', () => {
    it('applies multiple actions in order', () => {
      const config = baseConfig();
      const result = executor.applyBatch(config, [
        action('set_job_name', { name: 'Test Job' }),
        action('add_seed_urls', { urls: [{ url: 'https://example.com' }] }),
        action('set_crawl_depth', { maxDepth: 3 }),
      ]);
      expect(result.name).toBe('Test Job');
      expect(result.seedUrls).toEqual(['https://example.com']);
      expect(result.crawl.maxDepth).toBe(3);
    });
  });

  describe('validate', () => {
    it('reports missing required fields', () => {
      const config = baseConfig();
      const result = executor.validate(config);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('name');
      expect(result.missing).toContain('seedUrls');
    });

    it('passes for complete config', () => {
      const config = {
        ...baseConfig(),
        name: 'Test',
        description: 'Test desc',
        seedUrls: ['https://example.com'],
      };
      const result = executor.validate(config);
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('warns about large page counts', () => {
      const config = {
        ...baseConfig(),
        name: 'Test',
        description: 'Test desc',
        seedUrls: ['https://example.com'],
        crawl: { ...baseConfig().crawl, maxPages: 10000 },
      };
      const result = executor.validate(config);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('diff', () => {
    it('detects changed fields', () => {
      const before = baseConfig();
      const after = { ...before, name: 'Changed' };
      const result = executor.diff(before, after);
      expect(result.changes.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.path === 'name')).toBe(true);
    });

    it('returns empty changes for identical configs', () => {
      const config = baseConfig();
      const result = executor.diff(config, config);
      expect(result.changes).toHaveLength(0);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd packages/core && pnpm test -- --run tests/unit/config/config-executor.test.ts
```

Expected: FAIL — `DefaultConfigExecutor` not found.

**Step 3: Implement DefaultConfigExecutor**

Create `packages/core/src/config/config-executor.ts`:

```typescript
import type {
  ConfigExecutor,
  ConfigValidationResult,
  ConfigDiff,
} from '../interfaces/config-executor.js';
import type { JobConfig } from '../types/job.js';
import type { ConfigAction } from '../types/config-actions.js';

export class DefaultConfigExecutor implements ConfigExecutor {
  apply(config: JobConfig, action: ConfigAction): JobConfig {
    // Deep clone to avoid mutations
    const next = structuredClone(config);

    switch (action.type) {
      // --- Metadata ---
      case 'set_job_name':
        next.name = action.payload.name;
        break;

      case 'set_job_description':
        next.description = action.payload.description;
        break;

      // --- Seed URLs ---
      case 'add_seed_urls': {
        const existing = new Set(next.seedUrls);
        for (const entry of action.payload.urls) {
          existing.add(entry.url);
        }
        next.seedUrls = [...existing];
        break;
      }

      case 'remove_seed_urls':
        next.seedUrls = next.seedUrls.filter((u) => !action.payload.urls.includes(u));
        break;

      case 'replace_seed_urls':
        next.seedUrls = action.payload.urls.map((u) => u.url);
        break;

      // --- Crawl Settings ---
      case 'set_crawl_depth':
        next.crawl.maxDepth = action.payload.maxDepth;
        break;

      case 'set_max_pages':
        next.crawl.maxPages = action.payload.maxPages;
        break;

      case 'set_concurrency':
        next.crawl.concurrency = action.payload.concurrency;
        break;

      case 'set_crawler_type':
        next.crawl.crawlerType = action.payload.crawlerType;
        break;

      // --- Schema Fields ---
      case 'add_user_field': {
        if (!next.schema.userFields) next.schema.userFields = [];
        const field = action.payload.field;
        if (action.payload.position === 'first') {
          next.schema.userFields.unshift(field);
        } else if (action.payload.position === 'after' && action.payload.afterField) {
          const idx = next.schema.userFields.findIndex((f) => f.name === action.payload.afterField);
          if (idx >= 0) {
            next.schema.userFields.splice(idx + 1, 0, field);
          } else {
            next.schema.userFields.push(field);
          }
        } else {
          next.schema.userFields.push(field);
        }
        break;
      }

      case 'add_multiple_user_fields':
        if (!next.schema.userFields) next.schema.userFields = [];
        next.schema.userFields.push(...action.payload.fields);
        break;

      case 'remove_user_field':
        if (next.schema.userFields) {
          next.schema.userFields = next.schema.userFields.filter(
            (f) => f.name !== action.payload.fieldName,
          );
        }
        break;

      case 'modify_user_field': {
        if (next.schema.userFields) {
          const idx = next.schema.userFields.findIndex((f) => f.name === action.payload.fieldName);
          if (idx >= 0) {
            next.schema.userFields[idx] = {
              ...next.schema.userFields[idx],
              ...action.payload.changes,
            };
          }
        }
        break;
      }

      case 'reorder_user_fields': {
        if (next.schema.userFields) {
          const ordered: typeof next.schema.userFields = [];
          for (const name of action.payload.fieldOrder) {
            const field = next.schema.userFields.find((f) => f.name === name);
            if (field) ordered.push(field);
          }
          // Append any fields not mentioned in the order
          for (const field of next.schema.userFields) {
            if (!action.payload.fieldOrder.includes(field.name)) {
              ordered.push(field);
            }
          }
          next.schema.userFields = ordered;
        }
        break;
      }

      case 'replace_all_user_fields':
        next.schema.userFields = [...action.payload.fields];
        break;

      case 'define_nested_field': {
        if (next.schema.userFields) {
          const idx = next.schema.userFields.findIndex(
            (f) => f.name === action.payload.parentFieldName,
          );
          if (idx >= 0 && next.schema.userFields[idx].type === 'object') {
            next.schema.userFields[idx].objectFields = action.payload.subFields;
          }
        }
        break;
      }

      // --- Schema Mode ---
      case 'set_schema_mode':
        next.schema.mode = action.payload.mode;
        break;

      case 'set_evolution_config': {
        const existing = next.schema.evolutionConfig ?? {
          enabled: true,
          batchSize: 10,
          maxFields: 50,
          relevanceThresholds: {
            requiredMin: 0.85,
            optionalMin: 0.4,
            rareBelow: 0.4,
            minCategorySampleSize: 5,
          },
          tableStrategy: 'auto' as const,
        };
        next.schema.evolutionConfig = {
          ...existing,
          ...(action.payload.enabled !== undefined && { enabled: action.payload.enabled }),
          ...(action.payload.batchSize !== undefined && { batchSize: action.payload.batchSize }),
          ...(action.payload.maxFields !== undefined && { maxFields: action.payload.maxFields }),
          ...(action.payload.relevanceThresholds !== undefined && {
            relevanceThresholds: {
              ...existing.relevanceThresholds,
              ...action.payload.relevanceThresholds,
            },
          }),
          ...(action.payload.tableStrategy !== undefined && {
            tableStrategy: action.payload.tableStrategy,
          }),
        };
        break;
      }

      // --- LLM Config ---
      case 'set_primary_model':
        next.llm.primaryModel = action.payload.model;
        break;

      case 'set_model_override': {
        if (!next.llm.modelOverrides) next.llm.modelOverrides = {};
        (next.llm.modelOverrides as Record<string, string>)[action.payload.task] =
          action.payload.model;
        break;
      }

      case 'clear_model_override': {
        if (next.llm.modelOverrides) {
          delete (next.llm.modelOverrides as Record<string, string | undefined>)[
            action.payload.task
          ];
        }
        break;
      }

      // --- Reconciliation ---
      case 'set_match_strategy': {
        if (!next.reconciliation) {
          next.reconciliation = {
            matchStrategy: 'composite_key',
            conflictResolution: 'most_complete',
            fuzzyMatchThreshold: 0.85,
            enableLLMMatching: true,
          };
        }
        next.reconciliation.matchStrategy = action.payload.matchStrategy;
        if (action.payload.fuzzyMatchThreshold !== undefined) {
          next.reconciliation.fuzzyMatchThreshold = action.payload.fuzzyMatchThreshold;
        }
        if (action.payload.enableLLMMatching !== undefined) {
          next.reconciliation.enableLLMMatching = action.payload.enableLLMMatching;
        }
        break;
      }

      case 'set_conflict_resolution': {
        if (!next.reconciliation) {
          next.reconciliation = {
            matchStrategy: 'composite_key',
            conflictResolution: 'most_complete',
            fuzzyMatchThreshold: 0.85,
            enableLLMMatching: true,
          };
        }
        next.reconciliation.conflictResolution = action.payload.strategy;
        break;
      }

      case 'set_source_priority': {
        if (!next.reconciliation) {
          next.reconciliation = {
            matchStrategy: 'composite_key',
            conflictResolution: 'most_complete',
            fuzzyMatchThreshold: 0.85,
            enableLLMMatching: true,
          };
        }
        next.reconciliation.sourcePriority = action.payload.rankings.map((r) => r.domain);
        break;
      }

      // --- Safety ---
      case 'set_action_approval_policy':
        // Approval policy is stored as job metadata; not part of JobConfig schema.
        // This is a no-op at the config level — the CLI stores it separately.
        break;

      // --- Templates ---
      case 'save_as_template':
      case 'load_template':
      case 'clone_job_config':
        // Template operations are handled at the CLI/API level, not the config executor.
        break;

      // --- Control ---
      case 'confirm_and_start':
        // Handled by the CLI to trigger job creation. No config mutation.
        break;

      case 'reset_config': {
        const keepFields = action.payload.keepFields ?? [];
        const defaults = this.emptyConfig(next.tenantId);
        for (const key of Object.keys(defaults) as Array<keyof JobConfig>) {
          if (key === 'tenantId') continue;
          if (keepFields.includes(key as string)) continue;
          (next as Record<string, unknown>)[key] = (defaults as Record<string, unknown>)[key];
        }
        break;
      }
    }

    return next;
  }

  applyBatch(config: JobConfig, actions: ConfigAction[]): JobConfig {
    let result = config;
    for (const action of actions) {
      result = this.apply(result, action);
    }
    return result;
  }

  validate(config: JobConfig): ConfigValidationResult {
    const missing: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (!config.name || config.name.trim() === '') missing.push('name');
    if (!config.description || config.description.trim() === '') missing.push('description');
    if (!config.seedUrls || config.seedUrls.length === 0) missing.push('seedUrls');

    if (
      config.schema.mode === 'fixed' &&
      (!config.schema.userFields || config.schema.userFields.length === 0)
    ) {
      missing.push('userFields (required for fixed schema mode)');
    }

    if (config.crawl.maxPages > 5000) {
      warnings.push(`High page count (${config.crawl.maxPages}) — may be slow and expensive`);
    }

    if (config.crawl.concurrency > 10) {
      warnings.push(`High concurrency (${config.crawl.concurrency}) — may trigger rate limiting`);
    }

    if (config.schema.mode === 'discovery' && config.schema.userFields?.length) {
      suggestions.push(
        'Consider "hybrid" mode since you have user-defined fields with discovery enabled',
      );
    }

    return {
      valid: missing.length === 0,
      missing,
      warnings,
      suggestions,
    };
  }

  diff(before: JobConfig, after: JobConfig): ConfigDiff {
    const changes: ConfigDiff['changes'] = [];

    if (before.name !== after.name) {
      changes.push({
        path: 'name',
        before: before.name,
        after: after.name,
        description: 'Job name changed',
      });
    }
    if (before.description !== after.description) {
      changes.push({
        path: 'description',
        before: before.description,
        after: after.description,
        description: 'Description changed',
      });
    }
    if (JSON.stringify(before.seedUrls) !== JSON.stringify(after.seedUrls)) {
      changes.push({
        path: 'seedUrls',
        before: before.seedUrls,
        after: after.seedUrls,
        description: 'Seed URLs changed',
      });
    }
    if (JSON.stringify(before.crawl) !== JSON.stringify(after.crawl)) {
      changes.push({
        path: 'crawl',
        before: before.crawl,
        after: after.crawl,
        description: 'Crawl settings changed',
      });
    }
    if (JSON.stringify(before.schema) !== JSON.stringify(after.schema)) {
      changes.push({
        path: 'schema',
        before: before.schema,
        after: after.schema,
        description: 'Schema config changed',
      });
    }
    if (JSON.stringify(before.llm) !== JSON.stringify(after.llm)) {
      changes.push({
        path: 'llm',
        before: before.llm,
        after: after.llm,
        description: 'LLM config changed',
      });
    }
    if (JSON.stringify(before.reconciliation) !== JSON.stringify(after.reconciliation)) {
      changes.push({
        path: 'reconciliation',
        before: before.reconciliation,
        after: after.reconciliation,
        description: 'Reconciliation config changed',
      });
    }

    return { changes };
  }

  private emptyConfig(tenantId: string): JobConfig {
    return {
      tenantId,
      name: '',
      description: '',
      seedUrls: [],
      crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
      schema: { mode: 'discovery' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    };
  }
}
```

Create `packages/core/src/config/index.ts`:

```typescript
export { DefaultConfigExecutor } from './config-executor.js';
```

**Step 4: Update core barrel export**

Add to `packages/core/src/index.ts`:

```typescript
export * from './config/index.js';
```

**Step 5: Run tests to verify they pass**

```bash
cd packages/core && pnpm test -- --run tests/unit/config/config-executor.test.ts
```

Expected: All tests PASS.

**Step 6: Run full core test suite to ensure no regressions**

```bash
cd packages/core && pnpm test
```

Expected: All existing + new tests pass.

**Step 7: Commit**

```bash
git add packages/core/src/config/ packages/core/src/index.ts packages/core/tests/unit/config/
git commit -m "feat(core): implement DefaultConfigExecutor for all 30 ConfigAction types"
```

---

## Task 3: API Client — HTTP Communication Layer

**Files:**

- Create: `apps/cli/src/api/client.ts`
- Test: `apps/cli/tests/unit/api/client.test.ts`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/api/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpatulaApiClient, ApiError } from '../../src/api/client.js';

const BASE_URL = 'http://localhost:3000';
const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('SpatulaApiClient', () => {
  let client: SpatulaApiClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new SpatulaApiClient(BASE_URL, TENANT_ID);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(data: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    });
  }

  describe('createJob', () => {
    it('posts to /api/v1/jobs and returns job data', async () => {
      const jobBody = { name: 'Test', description: 'Desc', seedUrls: ['https://a.com'] };
      mockResponse({ data: { id: 'job-1', ...jobBody } }, 201);

      const result = await client.createJob(jobBody);

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-tenant-id': TENANT_ID,
            'Content-Type': 'application/json',
          }),
        }),
      );
      expect(result.id).toBe('job-1');
    });
  });

  describe('listJobs', () => {
    it('fetches /api/v1/jobs with query params', async () => {
      mockResponse({ data: [{ id: 'job-1' }, { id: 'job-2' }] });

      const result = await client.listJobs({ status: 'running', limit: 10 });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs?status=running&limit=10`,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result).toHaveLength(2);
    });

    it('fetches without params when none given', async () => {
      mockResponse({ data: [] });
      await client.listJobs();
      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/api/v1/jobs`, expect.anything());
    });
  });

  describe('getJob', () => {
    it('fetches single job by id', async () => {
      mockResponse({ data: { id: 'job-1', name: 'Test' } });
      const result = await client.getJob('job-1');
      expect(result.id).toBe('job-1');
    });
  });

  describe('lifecycle methods', () => {
    it('startJob posts to /start', async () => {
      mockResponse({ data: { id: 'job-1' } });
      await client.startJob('job-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs/job-1/start`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('pauseJob posts to /pause', async () => {
      mockResponse({ data: { id: 'job-1' } });
      await client.pauseJob('job-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs/job-1/pause`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('cancelJob posts to /cancel', async () => {
      mockResponse({ data: { id: 'job-1' } });
      await client.cancelJob('job-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs/job-1/cancel`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('entity methods', () => {
    it('listEntities fetches with pagination', async () => {
      mockResponse({ data: [{ id: 'e-1' }] });
      await client.listEntities('job-1', { limit: 20, offset: 0 });
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs/job-1/entities?limit=20&offset=0`,
        expect.anything(),
      );
    });

    it('getEntity fetches single entity', async () => {
      mockResponse({ data: { id: 'e-1', name: 'Product A' } });
      const result = await client.getEntity('job-1', 'e-1');
      expect(result.id).toBe('e-1');
    });
  });

  describe('action methods', () => {
    it('approveAction posts to /approve', async () => {
      mockResponse({ data: { id: 'act-1' } });
      await client.approveAction('job-1', 'act-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs/job-1/actions/act-1/approve`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('approveAllActions posts to /approve-all', async () => {
      mockResponse({ data: [] });
      await client.approveAllActions('job-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/jobs/job-1/actions/approve-all`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws ApiError on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: 'NOT_FOUND', message: 'Job not found' } }),
      });

      await expect(client.getJob('missing')).rejects.toThrow(ApiError);
      await expect(client.getJob('missing').catch((e) => e)).resolves.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    it('throws ApiError on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));
      await expect(client.listJobs()).rejects.toThrow(ApiError);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/api/client.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement the API client**

Create `apps/cli/src/api/client.ts`:

```typescript
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class SpatulaApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tenantId: string,
  ) {}

  // --- Jobs ---

  async createJob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post('/api/v1/jobs', body);
  }

  async listJobs(query?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return this.getList('/api/v1/jobs', query);
  }

  async getJob(id: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${id}`);
  }

  async startJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/start`);
  }

  async pauseJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/pause`);
  }

  async resumeJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/resume`);
  }

  async cancelJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/cancel`);
  }

  async triggerReconciliation(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/reconcile`);
  }

  // --- Schema ---

  async getSchema(jobId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/schema`);
  }

  async listSchemaVersions(jobId: string): Promise<Record<string, unknown>[]> {
    return this.getList(`/api/v1/jobs/${jobId}/schema/versions`);
  }

  // --- Extractions ---

  async listExtractions(
    jobId: string,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return this.getList(`/api/v1/jobs/${jobId}/extractions`, query);
  }

  // --- Entities ---

  async listEntities(
    jobId: string,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return this.getList(`/api/v1/jobs/${jobId}/entities`, query);
  }

  async getEntity(jobId: string, entityId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/entities/${entityId}`);
  }

  // --- Actions ---

  async listActions(
    jobId: string,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return this.getList(`/api/v1/jobs/${jobId}/actions`, query);
  }

  async approveAction(
    jobId: string,
    actionId: string,
    reviewedBy?: string,
  ): Promise<Record<string, unknown>> {
    return this.post(
      `/api/v1/jobs/${jobId}/actions/${actionId}/approve`,
      reviewedBy ? { reviewedBy } : undefined,
    );
  }

  async rejectAction(
    jobId: string,
    actionId: string,
    reviewedBy?: string,
  ): Promise<Record<string, unknown>> {
    return this.post(
      `/api/v1/jobs/${jobId}/actions/${actionId}/reject`,
      reviewedBy ? { reviewedBy } : undefined,
    );
  }

  async approveAllActions(jobId: string, reviewedBy?: string): Promise<Record<string, unknown>[]> {
    const result = await this.post(
      `/api/v1/jobs/${jobId}/actions/approve-all`,
      reviewedBy ? { reviewedBy } : undefined,
    );
    return Array.isArray(result) ? result : [];
  }

  // --- Private helpers ---

  private headers(): Record<string, string> {
    return {
      'x-tenant-id': this.tenantId,
      'Content-Type': 'application/json',
    };
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = `${this.baseUrl}${path}`;
    if (!query || Object.keys(query).length === 0) return url;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
    return `${url}?${params.toString()}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.buildUrl(path), {
        method,
        headers: this.headers(),
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiError(`Network error: ${(error as Error).message}`, 0, 'NETWORK_ERROR');
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const err = data.error as Record<string, unknown> | undefined;
      throw new ApiError(
        (err?.message as string) ?? `HTTP ${response.status}`,
        response.status,
        (err?.code as string) ?? undefined,
      );
    }

    return data.data;
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    return this.request('GET', path) as Promise<Record<string, unknown>>;
  }

  private async getList(
    path: string,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    let response: Response;
    try {
      response = await fetch(this.buildUrl(path, query), {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (error) {
      throw new ApiError(`Network error: ${(error as Error).message}`, 0, 'NETWORK_ERROR');
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const err = data.error as Record<string, unknown> | undefined;
      throw new ApiError(
        (err?.message as string) ?? `HTTP ${response.status}`,
        response.status,
        (err?.code as string) ?? undefined,
      );
    }

    return data.data as Record<string, unknown>[];
  }

  private async post(path: string, body?: unknown): Promise<Record<string, unknown>> {
    return this.request('POST', path, body) as Promise<Record<string, unknown>>;
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/api/client.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/cli/src/api/ apps/cli/tests/unit/api/
git commit -m "feat(cli): add SpatulaApiClient HTTP wrapper for all API endpoints"
```

---

## Task 4: Zustand Store — Global CLI State

**Files:**

- Create: `apps/cli/src/store/index.ts`
- Test: `apps/cli/tests/unit/store/index.test.ts`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/store/index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createCliStore, type CliStore } from '../../src/store/index.js';
import type { ConfigAction } from '@spatula/core';
import { randomUUID } from 'crypto';

function action(type: string, payload: Record<string, unknown>): ConfigAction {
  return { id: randomUUID(), type, reasoning: 'test', payload } as ConfigAction;
}

describe('CliStore', () => {
  let store: ReturnType<typeof createCliStore>;

  beforeEach(() => {
    store = createCliStore('550e8400-e29b-41d4-a716-446655440000');
  });

  describe('initial state', () => {
    it('starts in conversational mode', () => {
      expect(store.getState().mode).toBe('conversational');
    });

    it('starts with empty config', () => {
      const config = store.getState().config;
      expect(config.name).toBe('');
      expect(config.seedUrls).toEqual([]);
    });

    it('starts with empty messages', () => {
      expect(store.getState().messages).toEqual([]);
    });
  });

  describe('mode switching', () => {
    it('switches mode', () => {
      store.getState().setMode('dashboard');
      expect(store.getState().mode).toBe('dashboard');
    });
  });

  describe('config actions', () => {
    it('applies a single config action', () => {
      store.getState().applyActions([action('set_job_name', { name: 'My Job' })]);
      expect(store.getState().config.name).toBe('My Job');
    });

    it('applies multiple config actions', () => {
      store
        .getState()
        .applyActions([
          action('set_job_name', { name: 'Test' }),
          action('add_seed_urls', { urls: [{ url: 'https://example.com' }] }),
        ]);
      expect(store.getState().config.name).toBe('Test');
      expect(store.getState().config.seedUrls).toEqual(['https://example.com']);
    });

    it('tracks applied action history', () => {
      store.getState().applyActions([action('set_job_name', { name: 'Test' })]);
      expect(store.getState().actionHistory).toHaveLength(1);
    });
  });

  describe('config reset', () => {
    it('resets config to empty state', () => {
      store.getState().applyActions([action('set_job_name', { name: 'Test' })]);
      store.getState().resetConfig();
      expect(store.getState().config.name).toBe('');
    });

    it('clears action history on reset', () => {
      store.getState().applyActions([action('set_job_name', { name: 'Test' })]);
      store.getState().resetConfig();
      expect(store.getState().actionHistory).toEqual([]);
    });
  });

  describe('messages', () => {
    it('adds a user message', () => {
      store.getState().addMessage({ role: 'user', content: 'Hello' });
      expect(store.getState().messages).toHaveLength(1);
      expect(store.getState().messages[0].role).toBe('user');
    });

    it('adds an assistant message', () => {
      store
        .getState()
        .addMessage({ role: 'assistant', content: 'I will help you set up a crawl.' });
      expect(store.getState().messages[0].role).toBe('assistant');
    });

    it('clears messages', () => {
      store.getState().addMessage({ role: 'user', content: 'Hello' });
      store.getState().clearMessages();
      expect(store.getState().messages).toEqual([]);
    });
  });

  describe('loading state', () => {
    it('tracks loading state', () => {
      expect(store.getState().isLoading).toBe(false);
      store.getState().setLoading(true);
      expect(store.getState().isLoading).toBe(true);
    });
  });

  describe('active job', () => {
    it('tracks active job id', () => {
      expect(store.getState().activeJobId).toBeNull();
      store.getState().setActiveJobId('job-1');
      expect(store.getState().activeJobId).toBe('job-1');
    });
  });

  describe('validation', () => {
    it('validates current config', () => {
      const result = store.getState().validateConfig();
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('name');
    });

    it('passes validation for complete config', () => {
      store
        .getState()
        .applyActions([
          action('set_job_name', { name: 'Test' }),
          action('set_job_description', { description: 'Test desc' }),
          action('add_seed_urls', { urls: [{ url: 'https://example.com' }] }),
        ]);
      const result = store.getState().validateConfig();
      expect(result.valid).toBe(true);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/store/index.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement the Zustand store**

Create `apps/cli/src/store/index.ts`:

```typescript
import { createStore } from 'zustand/vanilla';
import type { ConfigAction, JobConfig, ConfigValidationResult } from '@spatula/core';
import { DefaultConfigExecutor } from '@spatula/core';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  actions?: ConfigAction[];
  timestamp?: number;
}

export type CliMode = 'conversational' | 'dashboard' | 'review' | 'explorer';

export interface CliState {
  // Mode
  mode: CliMode;
  setMode: (mode: CliMode) => void;

  // Config (being built in conversational mode)
  config: JobConfig;
  applyActions: (actions: ConfigAction[]) => void;
  resetConfig: () => void;
  validateConfig: () => ConfigValidationResult;

  // Action history (for undo/display)
  actionHistory: ConfigAction[];

  // Chat messages
  messages: ChatMessage[];
  addMessage: (message: Omit<ChatMessage, 'timestamp'>) => void;
  clearMessages: () => void;

  // Loading state
  isLoading: boolean;
  setLoading: (loading: boolean) => void;

  // Active job
  activeJobId: string | null;
  setActiveJobId: (id: string | null) => void;

  // Error
  error: string | null;
  setError: (error: string | null) => void;
}

const executor = new DefaultConfigExecutor();

function emptyConfig(tenantId: string): JobConfig {
  return {
    tenantId,
    name: '',
    description: '',
    seedUrls: [],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
  };
}

export function createCliStore(tenantId: string) {
  return createStore<CliState>((set, get) => ({
    mode: 'conversational',
    setMode: (mode) => set({ mode }),

    config: emptyConfig(tenantId),
    applyActions: (actions) =>
      set((state) => ({
        config: executor.applyBatch(state.config, actions),
        actionHistory: [...state.actionHistory, ...actions],
      })),
    resetConfig: () => set({ config: emptyConfig(tenantId), actionHistory: [] }),
    validateConfig: () => executor.validate(get().config),

    actionHistory: [],

    messages: [],
    addMessage: (message) =>
      set((state) => ({
        messages: [...state.messages, { ...message, timestamp: Date.now() }],
      })),
    clearMessages: () => set({ messages: [] }),

    isLoading: false,
    setLoading: (isLoading) => set({ isLoading }),

    activeJobId: null,
    setActiveJobId: (activeJobId) => set({ activeJobId }),

    error: null,
    setError: (error) => set({ error }),
  }));
}

export type CliStore = ReturnType<typeof createCliStore>;
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/store/index.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/cli/src/store/ apps/cli/tests/unit/store/
git commit -m "feat(cli): add Zustand store with config action reducer and chat message state"
```

---

## Task 5: Shared UI Components — Panel, Header, Spinner, KeyboardHints

**Files:**

- Create: `apps/cli/src/components/shared/Panel.tsx`
- Create: `apps/cli/src/components/shared/Header.tsx`
- Create: `apps/cli/src/components/shared/Spinner.tsx`
- Create: `apps/cli/src/components/shared/KeyboardHints.tsx`
- Create: `apps/cli/src/components/shared/index.tsx`
- Test: `apps/cli/tests/unit/components/shared/panel.test.tsx`
- Test: `apps/cli/tests/unit/components/shared/header.test.tsx`
- Test: `apps/cli/tests/unit/components/shared/keyboard-hints.test.tsx`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/components/shared/panel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Panel } from '../../../../src/components/shared/Panel.js';

describe('Panel', () => {
  it('renders title and children', () => {
    const { lastFrame } = render(
      <Panel title="Config">
        <React.Fragment>Hello World</React.Fragment>
      </Panel>,
    );
    const frame = lastFrame();
    expect(frame).toContain('Config');
    expect(frame).toContain('Hello World');
  });

  it('renders without title', () => {
    const { lastFrame } = render(
      <Panel>
        <React.Fragment>Content</React.Fragment>
      </Panel>,
    );
    expect(lastFrame()).toContain('Content');
  });
});
```

Create `apps/cli/tests/unit/components/shared/header.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Header } from '../../../../src/components/shared/Header.js';

describe('Header', () => {
  it('renders app name', () => {
    const { lastFrame } = render(<Header mode="conversational" />);
    expect(lastFrame()).toContain('Spatula');
  });

  it('renders current mode', () => {
    const { lastFrame } = render(<Header mode="dashboard" />);
    expect(lastFrame()).toContain('dashboard');
  });
});
```

Create `apps/cli/tests/unit/components/shared/keyboard-hints.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { KeyboardHints } from '../../../../src/components/shared/KeyboardHints.js';

describe('KeyboardHints', () => {
  it('renders hints', () => {
    const hints = [
      { key: 'Enter', description: 'Send' },
      { key: 'Ctrl+C', description: 'Quit' },
    ];
    const { lastFrame } = render(<KeyboardHints hints={hints} />);
    const frame = lastFrame();
    expect(frame).toContain('Enter');
    expect(frame).toContain('Send');
    expect(frame).toContain('Ctrl+C');
    expect(frame).toContain('Quit');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/shared/
```

Expected: FAIL — modules not found.

**Step 3: Implement shared components**

Create `apps/cli/src/components/shared/Panel.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

interface PanelProps {
  title?: string;
  children: React.ReactNode;
  borderColor?: string;
  width?: number | string;
}

export function Panel({ title, children, borderColor = 'cyan', width }: PanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={width}
    >
      {title && (
        <Box marginBottom={1}>
          <Text bold color={borderColor}>
            {title}
          </Text>
        </Box>
      )}
      {children}
    </Box>
  );
}
```

Create `apps/cli/src/components/shared/Header.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { CliMode } from '../../store/index.js';

interface HeaderProps {
  mode: CliMode;
}

const MODE_LABELS: Record<CliMode, string> = {
  conversational: 'conversational',
  dashboard: 'dashboard',
  review: 'review',
  explorer: 'explorer',
};

export function Header({ mode }: HeaderProps) {
  return (
    <Box paddingX={1} marginBottom={1}>
      <Text bold color="magenta">
        Spatula
      </Text>
      <Text dimColor> | </Text>
      <Text color="cyan">{MODE_LABELS[mode]}</Text>
    </Box>
  );
}
```

Create `apps/cli/src/components/shared/Spinner.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = 'Loading...' }: SpinnerProps) {
  return (
    <Box>
      <Text color="cyan">
        <InkSpinner type="dots" />
      </Text>
      <Text> {label}</Text>
    </Box>
  );
}
```

Create `apps/cli/src/components/shared/KeyboardHints.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

export interface KeyHint {
  key: string;
  description: string;
}

interface KeyboardHintsProps {
  hints: KeyHint[];
}

export function KeyboardHints({ hints }: KeyboardHintsProps) {
  return (
    <Box paddingX={1} marginTop={1}>
      {hints.map((hint, i) => (
        <Box key={hint.key} marginRight={2}>
          <Text bold color="yellow">
            {hint.key}
          </Text>
          <Text dimColor> {hint.description}</Text>
          {i < hints.length - 1 && <Text dimColor> </Text>}
        </Box>
      ))}
    </Box>
  );
}
```

Create `apps/cli/src/components/shared/index.tsx`:

```tsx
export { Panel } from './Panel.js';
export { Header } from './Header.js';
export { Spinner } from './Spinner.js';
export { KeyboardHints } from './KeyboardHints.js';
export type { KeyHint } from './KeyboardHints.js';
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/shared/
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/cli/src/components/shared/ apps/cli/tests/unit/components/shared/
git commit -m "feat(cli): add shared UI components — Panel, Header, Spinner, KeyboardHints"
```

---

## Task 6: ConfigPanel — Job Config Display Component

**Files:**

- Create: `apps/cli/src/components/conversational/ConfigPanel.tsx`
- Test: `apps/cli/tests/unit/components/conversational/config-panel.test.tsx`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/components/conversational/config-panel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ConfigPanel } from '../../../../src/components/conversational/ConfigPanel.js';
import type { JobConfig } from '@spatula/core';

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    tenantId: 'test-tenant',
    name: '',
    description: '',
    seedUrls: [],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    ...overrides,
  };
}

describe('ConfigPanel', () => {
  it('renders empty config placeholder', () => {
    const { lastFrame } = render(<ConfigPanel config={makeConfig()} />);
    const frame = lastFrame();
    expect(frame).toContain('Config');
  });

  it('shows job name when set', () => {
    const { lastFrame } = render(
      <ConfigPanel config={makeConfig({ name: 'Audiophile Products' })} />,
    );
    expect(lastFrame()).toContain('Audiophile Products');
  });

  it('shows seed URLs when set', () => {
    const { lastFrame } = render(
      <ConfigPanel
        config={makeConfig({ seedUrls: ['https://headfi.org', 'https://canjam.org'] })}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('headfi.org');
    expect(frame).toContain('canjam.org');
  });

  it('shows user fields when set', () => {
    const { lastFrame } = render(
      <ConfigPanel
        config={makeConfig({
          schema: {
            mode: 'hybrid',
            userFields: [
              { name: 'price', description: 'Product price', type: 'currency', required: true },
              { name: 'brand', description: 'Brand name', type: 'string', required: false },
            ],
          },
        })}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('price');
    expect(frame).toContain('brand');
  });

  it('shows schema mode', () => {
    const { lastFrame } = render(
      <ConfigPanel config={makeConfig({ schema: { mode: 'hybrid' } })} />,
    );
    expect(lastFrame()).toContain('hybrid');
  });

  it('shows crawl settings', () => {
    const { lastFrame } = render(
      <ConfigPanel
        config={makeConfig({
          crawl: { maxDepth: 5, maxPages: 500, concurrency: 10, crawlerType: 'firecrawl' },
        })}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('500');
    expect(frame).toContain('firecrawl');
  });

  it('shows validation status', () => {
    const { lastFrame } = render(
      <ConfigPanel
        config={makeConfig({ name: 'Test', description: 'Desc', seedUrls: ['https://a.com'] })}
        isValid={true}
      />,
    );
    expect(lastFrame()).toContain('Ready');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/conversational/config-panel.test.tsx
```

Expected: FAIL — module not found.

**Step 3: Implement ConfigPanel**

Create `apps/cli/src/components/conversational/ConfigPanel.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { JobConfig } from '@spatula/core';
import { Panel } from '../shared/Panel.js';

interface ConfigPanelProps {
  config: JobConfig;
  isValid?: boolean;
}

export function ConfigPanel({ config, isValid }: ConfigPanelProps) {
  const hasName = config.name.trim() !== '';
  const hasDescription = config.description.trim() !== '';
  const hasUrls = config.seedUrls.length > 0;
  const hasFields = (config.schema.userFields?.length ?? 0) > 0;

  return (
    <Panel title="Config" borderColor={isValid ? 'green' : 'cyan'}>
      {/* Job metadata */}
      <Box flexDirection="column" marginBottom={hasUrls || hasFields ? 1 : 0}>
        <Box>
          <Text dimColor>Name: </Text>
          <Text>{hasName ? config.name : '(not set)'}</Text>
        </Box>
        {hasDescription && (
          <Box>
            <Text dimColor>Description: </Text>
            <Text>{config.description}</Text>
          </Box>
        )}
      </Box>

      {/* Seed URLs */}
      {hasUrls && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Seed URLs ({config.seedUrls.length}):</Text>
          {config.seedUrls.map((url) => (
            <Box key={url} paddingLeft={2}>
              <Text color="blue">{url}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Schema */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text dimColor>Schema: </Text>
          <Text color="yellow">{config.schema.mode}</Text>
        </Box>
        {hasFields && (
          <Box flexDirection="column" paddingLeft={2}>
            {config.schema.userFields!.map((f) => (
              <Box key={f.name}>
                <Text>{f.name}</Text>
                <Text dimColor> ({f.type})</Text>
                {f.required && <Text color="red"> *</Text>}
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Crawl settings */}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Crawl:</Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>
            depth={config.crawl.maxDepth} pages={config.crawl.maxPages} concurrency=
            {config.crawl.concurrency}
          </Text>
          <Text>crawler={config.crawl.crawlerType}</Text>
        </Box>
      </Box>

      {/* LLM */}
      <Box>
        <Text dimColor>Model: </Text>
        <Text>{config.llm.primaryModel}</Text>
      </Box>

      {/* Validation status */}
      <Box marginTop={1}>
        {isValid === true && <Text color="green">Ready to start</Text>}
        {isValid === false && <Text color="yellow">Incomplete — keep configuring</Text>}
      </Box>
    </Panel>
  );
}
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/conversational/config-panel.test.tsx
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/cli/src/components/conversational/ apps/cli/tests/unit/components/conversational/
git commit -m "feat(cli): add ConfigPanel component for displaying evolving job configuration"
```

---

## Task 7: ChatView — Conversational Message Display + Input

**Files:**

- Create: `apps/cli/src/components/conversational/ChatView.tsx`
- Test: `apps/cli/tests/unit/components/conversational/chat-view.test.tsx`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/components/conversational/chat-view.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ChatView } from '../../../../src/components/conversational/ChatView.js';
import type { ChatMessage } from '../../../../src/store/index.js';

describe('ChatView', () => {
  const noOp = vi.fn();

  it('renders welcome message when no messages', () => {
    const { lastFrame } = render(<ChatView messages={[]} onSubmit={noOp} isLoading={false} />);
    expect(lastFrame()).toContain('Describe');
  });

  it('renders user messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'I want to crawl audiophile products', timestamp: Date.now() },
    ];
    const { lastFrame } = render(
      <ChatView messages={messages} onSubmit={noOp} isLoading={false} />,
    );
    expect(lastFrame()).toContain('audiophile products');
  });

  it('renders assistant messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Setting up your audiophile crawl now.',
        timestamp: Date.now(),
      },
    ];
    const { lastFrame } = render(
      <ChatView messages={messages} onSubmit={noOp} isLoading={false} />,
    );
    expect(lastFrame()).toContain('Setting up');
  });

  it('shows loading indicator when processing', () => {
    const { lastFrame } = render(<ChatView messages={[]} onSubmit={noOp} isLoading={true} />);
    expect(lastFrame()).toContain('Thinking');
  });

  it('calls onSubmit when user submits text', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<ChatView messages={[]} onSubmit={onSubmit} isLoading={false} />);
    stdin.write('hello\r');
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });

  it('does not submit empty input', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<ChatView messages={[]} onSubmit={onSubmit} isLoading={false} />);
    stdin.write('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/conversational/chat-view.test.tsx
```

Expected: FAIL — module not found.

**Step 3: Implement ChatView**

Create `apps/cli/src/components/conversational/ChatView.tsx`:

```tsx
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { ChatMessage } from '../../store/index.js';
import { Spinner } from '../shared/Spinner.js';

interface ChatViewProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  isLoading: boolean;
}

export function ChatView({ messages, onSubmit, isLoading }: ChatViewProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === '') return;
    onSubmit(trimmed);
    setInput('');
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Messages area */}
      <Box flexDirection="column" marginBottom={1}>
        {messages.length === 0 && (
          <Box paddingX={1}>
            <Text dimColor>
              Describe what you want to crawl. For example: "I want to crawl audiophile products
              from headfi.org"
            </Text>
          </Box>
        )}

        {messages.map((msg, i) => (
          <Box key={i} paddingX={1} marginBottom={i < messages.length - 1 ? 1 : 0}>
            {msg.role === 'user' ? (
              <Box>
                <Text bold color="green">
                  You:{' '}
                </Text>
                <Text>{msg.content}</Text>
              </Box>
            ) : (
              <Box>
                <Text bold color="magenta">
                  AI:{' '}
                </Text>
                <Text>{msg.content}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>

      {/* Loading indicator */}
      {isLoading && (
        <Box paddingX={1} marginBottom={1}>
          <Spinner label="Thinking..." />
        </Box>
      )}

      {/* Input area */}
      <Box paddingX={1}>
        <Text bold color="green">
          {'> '}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={isLoading ? '' : 'Type your message...'}
        />
      </Box>
    </Box>
  );
}
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/conversational/chat-view.test.tsx
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/cli/src/components/conversational/ChatView.tsx apps/cli/tests/unit/components/conversational/chat-view.test.tsx
git commit -m "feat(cli): add ChatView component with message display and text input"
```

---

## Task 8: Config Conversation Service — LLM-Powered Config Builder

This is the core intelligence of conversational mode. It sends user messages to the LLM along with a system prompt explaining ConfigActions, and parses the response into structured actions.

**Files:**

- Create: `apps/cli/src/services/config-conversation.ts`
- Test: `apps/cli/tests/unit/services/config-conversation.test.ts`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/services/config-conversation.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigConversationService } from '../../src/services/config-conversation.js';
import type { LLMClient, LLMCompletionResponse } from '@spatula/core';
import type { JobConfig } from '@spatula/core';
import type { ChatMessage } from '../../src/store/index.js';

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    tenantId: 'test-tenant',
    name: '',
    description: '',
    seedUrls: [],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    ...overrides,
  };
}

function mockLLMResponse(responseText: string, actions: unknown[]): LLMCompletionResponse {
  return {
    content: JSON.stringify({ response: responseText, actions }),
    model: 'test-model',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason: 'stop',
  };
}

describe('ConfigConversationService', () => {
  let llmClient: LLMClient;
  let service: ConfigConversationService;

  beforeEach(() => {
    llmClient = {
      complete: vi.fn(),
    };
    service = new ConfigConversationService(llmClient, 'anthropic/claude-sonnet-4-20250514');
  });

  it('sends user message and returns parsed response', async () => {
    (llmClient.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockLLMResponse("I'll set up an audiophile product crawl for you.", [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          type: 'set_job_name',
          reasoning: 'User wants audiophile products',
          payload: { name: 'Audiophile Products' },
        },
      ]),
    );

    const result = await service.processMessage(
      'I want to crawl audiophile products',
      makeConfig(),
      [],
    );

    expect(result.responseText).toContain('audiophile');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe('set_job_name');
  });

  it('includes current config in system prompt', async () => {
    (llmClient.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockLLMResponse('Done.', []),
    );

    const config = makeConfig({ name: 'Existing Job' });
    await service.processMessage('Add headfi.org', config, []);

    const callArgs = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessage = callArgs.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).toContain('Existing Job');
  });

  it('includes message history in request', async () => {
    (llmClient.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockLLMResponse('Done.', []),
    );

    const history: ChatMessage[] = [
      { role: 'user', content: 'I want audiophile products', timestamp: Date.now() },
      { role: 'assistant', content: 'Setting up...', timestamp: Date.now() },
    ];

    await service.processMessage('Also add headfi.org', makeConfig(), history);

    const callArgs = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMessages = callArgs.messages.filter((m: { role: string }) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('uses jsonMode for structured output', async () => {
    (llmClient.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockLLMResponse('Done.', []),
    );

    await service.processMessage('test', makeConfig(), []);

    const callArgs = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.jsonMode).toBe(true);
  });

  it('handles LLM returning no actions', async () => {
    (llmClient.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockLLMResponse('Could you tell me more about what you want to crawl?', []),
    );

    const result = await service.processMessage('hello', makeConfig(), []);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toContain('tell me more');
  });

  it('handles malformed JSON gracefully', async () => {
    (llmClient.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: 'not valid json',
      model: 'test',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    });

    const result = await service.processMessage('test', makeConfig(), []);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toContain('trouble');
  });

  it('handles confirm_and_start action', async () => {
    (llmClient.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockLLMResponse('Starting your job!', [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          type: 'confirm_and_start',
          reasoning: 'User confirmed',
          payload: {},
        },
      ]),
    );

    const result = await service.processMessage('looks good, start it', makeConfig(), []);
    expect(result.actions.some((a) => a.type === 'confirm_and_start')).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/services/config-conversation.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement the conversation service**

Create `apps/cli/src/services/config-conversation.ts`:

```typescript
import type { LLMClient, ConfigAction, JobConfig } from '@spatula/core';
import type { ChatMessage } from '../store/index.js';
import { createLogger } from '@spatula/shared';

const logger = createLogger('config-conversation');

export interface ConversationResponse {
  responseText: string;
  actions: ConfigAction[];
}

export class ConfigConversationService {
  constructor(
    private readonly llm: LLMClient,
    private readonly model: string,
  ) {}

  async processMessage(
    userMessage: string,
    currentConfig: JobConfig,
    history: ChatMessage[],
  ): Promise<ConversationResponse> {
    const systemPrompt = this.buildSystemPrompt(currentConfig);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: userMessage },
    ];

    try {
      const response = await this.llm.complete({
        model: this.model,
        messages,
        jsonMode: true,
        temperature: 0.3,
        maxTokens: 4096,
      });

      return this.parseResponse(response.content);
    } catch (error) {
      logger.error({ error }, 'LLM call failed in config conversation');
      return {
        responseText: 'I had trouble processing that. Could you try rephrasing?',
        actions: [],
      };
    }
  }

  private parseResponse(content: string): ConversationResponse {
    try {
      const parsed = JSON.parse(content) as {
        response?: string;
        actions?: unknown[];
      };

      const responseText = parsed.response ?? 'Configuration updated.';
      const rawActions = parsed.actions ?? [];

      // Validate each action loosely — keep valid ones, skip invalid
      const actions: ConfigAction[] = [];
      for (const raw of rawActions) {
        if (raw && typeof raw === 'object' && 'type' in raw && 'id' in raw && 'payload' in raw) {
          actions.push(raw as ConfigAction);
        }
      }

      return { responseText, actions };
    } catch {
      logger.warn('Failed to parse LLM response as JSON');
      return {
        responseText: 'I had trouble understanding the response. Could you try again?',
        actions: [],
      };
    }
  }

  private buildSystemPrompt(config: JobConfig): string {
    return `You are Spatula's configuration assistant. You help users set up web crawling jobs through natural conversation.

## Your Role
Interpret user messages and produce structured ConfigActions to build up a job configuration. Always respond with both a human-readable explanation and a JSON array of actions.

## Current Configuration State
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`

## Response Format
You MUST respond with valid JSON in this exact format:
{
  "response": "Human-readable explanation of what you're doing",
  "actions": [
    {
      "id": "<uuid>",
      "type": "<action_type>",
      "reasoning": "<why this action>",
      "payload": { ... }
    }
  ]
}

## Available ConfigAction Types

### Metadata
- set_job_name: { name: string }
- set_job_description: { description: string }

### Seed URLs
- add_seed_urls: { urls: [{ url: string, label?: string }] }
- remove_seed_urls: { urls: string[] }
- replace_seed_urls: { urls: [{ url: string, label?: string }] }

### Crawl Settings
- set_crawl_depth: { maxDepth: number (0-10) }
- set_max_pages: { maxPages: number (min 1) }
- set_concurrency: { concurrency: number (1-20) }
- set_crawler_type: { crawlerType: "playwright" | "firecrawl" }

### Schema Fields
- add_user_field: { field: { name, description, type, required }, position?: "first" | "last" | "after", afterField?: string }
- add_multiple_user_fields: { fields: [{ name, description, type, required }] }
- remove_user_field: { fieldName: string }
- modify_user_field: { fieldName: string, changes: { name?, description?, type?, required? } }
- replace_all_user_fields: { fields: [...] }

Field types: string, number, boolean, url, currency, enum, array, object

### Schema Mode
- set_schema_mode: { mode: "fixed" | "discovery" | "hybrid" }
  - "discovery": AI discovers fields automatically
  - "fixed": only user-defined fields
  - "hybrid": user fields + AI discovery
- set_evolution_config: { enabled?, batchSize?, maxFields? }

### LLM Config
- set_primary_model: { model: string }
- set_model_override: { task: string, model: string }
- clear_model_override: { task: string }

### Reconciliation
- set_match_strategy: { matchStrategy: "exact_name" | "fuzzy_name" | "composite_key" | "llm_assisted", fuzzyMatchThreshold?: number }
- set_conflict_resolution: { strategy: "most_common" | "most_complete" | "source_priority" | "most_recent" | "llm_resolved" }

### Control
- confirm_and_start: {} — User is satisfied and wants to start the job
- reset_config: { keepFields?: string[] } — Reset configuration

## Guidelines
1. Be proactive — infer sensible defaults from user intent
2. When the user describes what they want, set name, description, seed URLs, and suggest schema mode
3. Use "discovery" mode by default unless user explicitly wants fixed fields
4. For UUIDs in action ids, generate plausible UUIDs
5. Ask clarifying questions when intent is ambiguous (return empty actions array)
6. When user says "start", "go", "looks good" etc., emit confirm_and_start
7. Keep responses concise and friendly`;
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/services/config-conversation.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/cli/src/services/ apps/cli/tests/unit/services/
git commit -m "feat(cli): add ConfigConversationService with LLM-powered config building"
```

---

## Task 9: ConversationalView + App Root — Wire Everything Together

**Files:**

- Create: `apps/cli/src/components/conversational/ConversationalView.tsx`
- Create: `apps/cli/src/components/conversational/index.tsx`
- Create: `apps/cli/src/components/App.tsx`
- Test: `apps/cli/tests/unit/components/conversational/conversational-view.test.tsx`
- Test: `apps/cli/tests/unit/components/app.test.tsx`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/components/conversational/conversational-view.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ConversationalView } from '../../../../src/components/conversational/ConversationalView.js';
import { createCliStore } from '../../../../src/store/index.js';

describe('ConversationalView', () => {
  it('renders both chat and config panels', () => {
    const store = createCliStore('test-tenant');
    const { lastFrame } = render(<ConversationalView store={store} onStartJob={vi.fn()} />);
    const frame = lastFrame();
    // Chat area should show welcome message
    expect(frame).toContain('Describe');
    // Config panel should show
    expect(frame).toContain('Config');
  });

  it('shows config panel with updated state', () => {
    const store = createCliStore('test-tenant');
    store.getState().applyActions([
      {
        id: 'test-id',
        type: 'set_job_name',
        reasoning: 'test',
        payload: { name: 'Test Job' },
      } as any,
    ]);

    const { lastFrame } = render(<ConversationalView store={store} onStartJob={vi.fn()} />);
    expect(lastFrame()).toContain('Test Job');
  });
});
```

Create `apps/cli/tests/unit/components/app.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../../src/components/App.js';
import { createCliStore } from '../../../src/store/index.js';

describe('App', () => {
  it('renders header with current mode', () => {
    const store = createCliStore('test-tenant');
    const { lastFrame } = render(<App store={store} onStartJob={vi.fn()} onExit={vi.fn()} />);
    const frame = lastFrame();
    expect(frame).toContain('Spatula');
    expect(frame).toContain('conversational');
  });

  it('renders keyboard hints', () => {
    const store = createCliStore('test-tenant');
    const { lastFrame } = render(<App store={store} onStartJob={vi.fn()} onExit={vi.fn()} />);
    expect(lastFrame()).toContain('Ctrl+C');
  });

  it('shows dashboard stub when mode is dashboard', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('dashboard');
    const { lastFrame } = render(<App store={store} onStartJob={vi.fn()} onExit={vi.fn()} />);
    expect(lastFrame()).toContain('Dashboard');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/conversational/conversational-view.test.tsx tests/unit/components/app.test.tsx
```

Expected: FAIL — modules not found.

**Step 3: Implement ConversationalView**

Create `apps/cli/src/components/conversational/ConversationalView.tsx`:

```tsx
import React, { useCallback } from 'react';
import { Box } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import { ChatView } from './ChatView.js';
import { ConfigPanel } from './ConfigPanel.js';

interface ConversationalViewProps {
  store: CliStore;
  onStartJob: (config: Record<string, unknown>) => void;
}

export function ConversationalView({ store, onStartJob }: ConversationalViewProps) {
  const config = useStore(store, (s) => s.config);
  const messages = useStore(store, (s) => s.messages);
  const isLoading = useStore(store, (s) => s.isLoading);
  const isValid = useStore(store, (s) => s.validateConfig().valid);

  const handleSubmit = useCallback(
    (input: string) => {
      // Add user message to store
      store.getState().addMessage({ role: 'user', content: input });

      // The actual LLM call is handled by the parent/orchestrator
      // This component just manages the UI state
    },
    [store],
  );

  return (
    <Box flexDirection="row" flexGrow={1}>
      {/* Chat panel — left side */}
      <Box flexDirection="column" flexGrow={1} marginRight={1}>
        <ChatView messages={messages} onSubmit={handleSubmit} isLoading={isLoading} />
      </Box>

      {/* Config panel — right side */}
      <Box width={40}>
        <ConfigPanel config={config} isValid={isValid} />
      </Box>
    </Box>
  );
}
```

Create `apps/cli/src/components/conversational/index.tsx`:

```tsx
export { ConversationalView } from './ConversationalView.js';
export { ChatView } from './ChatView.js';
export { ConfigPanel } from './ConfigPanel.js';
```

**Step 4: Implement App root component**

Create `apps/cli/src/components/App.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import { Header } from './shared/Header.js';
import { KeyboardHints } from './shared/KeyboardHints.js';
import { ConversationalView } from './conversational/ConversationalView.js';

interface AppProps {
  store: CliStore;
  onStartJob: (config: Record<string, unknown>) => void;
  onExit: () => void;
}

export function App({ store, onStartJob, onExit }: AppProps) {
  const mode = useStore(store, (s) => s.mode);

  const hints = [
    { key: 'Enter', description: 'Send' },
    { key: 'Ctrl+C', description: 'Quit' },
  ];

  return (
    <Box flexDirection="column" minHeight={20}>
      <Header mode={mode} />

      <Box flexGrow={1}>
        {mode === 'conversational' && <ConversationalView store={store} onStartJob={onStartJob} />}
        {mode === 'dashboard' && (
          <Box paddingX={1}>
            <Text dimColor>Dashboard mode — coming in Phase 9b</Text>
          </Box>
        )}
        {mode === 'review' && (
          <Box paddingX={1}>
            <Text dimColor>Review mode — coming in Phase 9b</Text>
          </Box>
        )}
        {mode === 'explorer' && (
          <Box paddingX={1}>
            <Text dimColor>Explorer mode — coming in Phase 9c</Text>
          </Box>
        )}
      </Box>

      <KeyboardHints hints={hints} />
    </Box>
  );
}
```

**Step 5: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/components/
```

Expected: All tests PASS.

**Step 6: Commit**

```bash
git add apps/cli/src/components/ apps/cli/tests/unit/components/
git commit -m "feat(cli): add ConversationalView and App root with mode routing"
```

---

## Task 10: CLI Entry Point — yargs Commands + Ink Render

**Files:**

- Modify: `apps/cli/src/index.tsx`
- Create: `apps/cli/src/commands/new.tsx`
- Create: `apps/cli/src/commands/list.ts`
- Create: `apps/cli/src/commands/status.ts`
- Test: `apps/cli/tests/unit/commands/list.test.ts`
- Test: `apps/cli/tests/unit/commands/status.test.ts`

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/commands/list.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runListCommand } from '../../src/commands/list.js';
import { SpatulaApiClient } from '../../src/api/client.js';

describe('list command', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls API and returns jobs', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'job-1', name: 'Test Job', status: 'running' },
          { id: 'job-2', name: 'Another', status: 'completed' },
        ],
      }),
    });

    const client = new SpatulaApiClient('http://localhost:3000', 'test-tenant');
    const jobs = await runListCommand(client, {});
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe('Test Job');
  });

  it('passes status filter', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });

    const client = new SpatulaApiClient('http://localhost:3000', 'test-tenant');
    await runListCommand(client, { status: 'running' });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=running'),
      expect.anything(),
    );
  });
});
```

Create `apps/cli/tests/unit/commands/status.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runStatusCommand } from '../../src/commands/status.js';
import { SpatulaApiClient } from '../../src/api/client.js';

describe('status command', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and returns job details', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: 'job-1',
          name: 'Test Job',
          status: 'running',
          stats: { pagesDiscovered: 50, pagesCompleted: 30 },
        },
      }),
    });

    const client = new SpatulaApiClient('http://localhost:3000', 'test-tenant');
    const job = await runStatusCommand(client, 'job-1');
    expect(job.id).toBe('job-1');
    expect(job.status).toBe('running');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --run tests/unit/commands/
```

Expected: FAIL — modules not found.

**Step 3: Implement command modules**

Create `apps/cli/src/commands/list.ts`:

```typescript
import type { SpatulaApiClient } from '../api/client.js';

export interface ListOptions {
  status?: string;
  limit?: number;
}

export async function runListCommand(
  client: SpatulaApiClient,
  options: ListOptions,
): Promise<Record<string, unknown>[]> {
  const query: Record<string, unknown> = {};
  if (options.status) query.status = options.status;
  if (options.limit) query.limit = options.limit;

  return client.listJobs(Object.keys(query).length > 0 ? query : undefined);
}

export function formatJobsTable(jobs: Record<string, unknown>[]): string {
  if (jobs.length === 0) return 'No jobs found.';

  const header = 'ID                    | Name                      | Status     ';
  const separator = '─'.repeat(header.length);
  const rows = jobs.map((j) => {
    const id = String(j.id ?? '')
      .slice(0, 21)
      .padEnd(21);
    const name = String(j.name ?? '')
      .slice(0, 25)
      .padEnd(25);
    const status = String(j.status ?? '').padEnd(10);
    return `${id} | ${name} | ${status}`;
  });

  return [header, separator, ...rows].join('\n');
}
```

Create `apps/cli/src/commands/status.ts`:

```typescript
import type { SpatulaApiClient } from '../api/client.js';

export async function runStatusCommand(
  client: SpatulaApiClient,
  jobId: string,
): Promise<Record<string, unknown>> {
  return client.getJob(jobId);
}

export function formatJobDetail(job: Record<string, unknown>): string {
  const lines = [`Job: ${job.name ?? 'Unnamed'}`, `ID: ${job.id}`, `Status: ${job.status}`];

  const stats = job.stats as Record<string, unknown> | undefined;
  if (stats) {
    lines.push('');
    lines.push('Stats:');
    if (stats.pagesDiscovered !== undefined)
      lines.push(`  Pages discovered: ${stats.pagesDiscovered}`);
    if (stats.pagesCompleted !== undefined)
      lines.push(`  Pages completed: ${stats.pagesCompleted}`);
    if (stats.entitiesFound !== undefined) lines.push(`  Entities found: ${stats.entitiesFound}`);
    if (stats.extractionCount !== undefined) lines.push(`  Extractions: ${stats.extractionCount}`);
  }

  return lines.join('\n');
}
```

Create `apps/cli/src/commands/new.tsx`:

```tsx
import React from 'react';
import { render } from 'ink';
import { App } from '../components/App.js';
import { createCliStore } from '../store/index.js';
import { ConfigConversationService } from '../services/config-conversation.js';
import { OpenRouterClient } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';
import type { ConfigAction } from '@spatula/core';

export interface NewCommandOptions {
  apiUrl: string;
  tenantId: string;
  openrouterApiKey: string;
  model?: string;
}

export async function runNewCommand(options: NewCommandOptions): Promise<void> {
  const store = createCliStore(options.tenantId);
  const apiClient = new SpatulaApiClient(options.apiUrl, options.tenantId);

  const llmClient = new OpenRouterClient({ apiKey: options.openrouterApiKey });
  const conversationService = new ConfigConversationService(
    llmClient,
    options.model ?? 'anthropic/claude-sonnet-4-20250514',
  );

  // Set up message handler — when user submits, process through LLM
  const unsubscribe = store.subscribe((state, prevState) => {
    const newMessages = state.messages;
    const prevMessages = prevState.messages;

    // Only trigger on new user messages
    if (
      newMessages.length > prevMessages.length &&
      newMessages[newMessages.length - 1].role === 'user'
    ) {
      const userMessage = newMessages[newMessages.length - 1].content;
      handleUserMessage(userMessage, store, conversationService, apiClient);
    }
  });

  const handleStartJob = async (config: Record<string, unknown>) => {
    try {
      const job = await apiClient.createJob(config);
      const jobId = job.id as string;
      await apiClient.startJob(jobId);
      store.getState().setActiveJobId(jobId);
      store.getState().addMessage({
        role: 'assistant',
        content: `Job created and started! ID: ${jobId}`,
      });
    } catch (error) {
      store.getState().setError(`Failed to create job: ${(error as Error).message}`);
    }
  };

  const handleExit = () => {
    unsubscribe();
    process.exit(0);
  };

  const { waitUntilExit } = render(
    <App store={store} onStartJob={handleStartJob} onExit={handleExit} />,
  );

  await waitUntilExit();
}

async function handleUserMessage(
  message: string,
  store: ReturnType<typeof createCliStore>,
  conversationService: ConfigConversationService,
  apiClient: SpatulaApiClient,
): Promise<void> {
  store.getState().setLoading(true);

  try {
    const result = await conversationService.processMessage(
      message,
      store.getState().config,
      store.getState().messages.slice(0, -1), // Exclude the message we just added
    );

    // Check for confirm_and_start
    const confirmAction = result.actions.find((a: ConfigAction) => a.type === 'confirm_and_start');
    const otherActions = result.actions.filter((a: ConfigAction) => a.type !== 'confirm_and_start');

    // Apply config actions
    if (otherActions.length > 0) {
      store.getState().applyActions(otherActions);
    }

    // Add AI response
    store.getState().addMessage({
      role: 'assistant',
      content: result.responseText,
      actions: result.actions,
    });

    // Handle confirm_and_start
    if (confirmAction) {
      const validation = store.getState().validateConfig();
      if (validation.valid) {
        const config = store.getState().config;
        try {
          const job = await apiClient.createJob({
            name: config.name,
            description: config.description,
            seedUrls: config.seedUrls,
            crawl: config.crawl,
            schema: config.schema,
            llm: config.llm,
            reconciliation: config.reconciliation,
          });
          const jobId = job.id as string;
          await apiClient.startJob(jobId);
          store.getState().setActiveJobId(jobId);
          store.getState().addMessage({
            role: 'system',
            content: `Job created and started! ID: ${jobId}. Switch to dashboard mode to monitor progress.`,
          });
        } catch (error) {
          store.getState().addMessage({
            role: 'system',
            content: `Failed to start job: ${(error as Error).message}`,
          });
        }
      } else {
        store.getState().addMessage({
          role: 'system',
          content: `Cannot start yet — missing: ${validation.missing.join(', ')}`,
        });
      }
    }
  } catch (error) {
    store.getState().addMessage({
      role: 'system',
      content: `Error: ${(error as Error).message}`,
    });
  } finally {
    store.getState().setLoading(false);
  }
}
```

**Step 4: Implement CLI entry point**

Replace `apps/cli/src/index.tsx` with:

```tsx
#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runNewCommand } from './commands/new.js';
import { runListCommand, formatJobsTable } from './commands/list.js';
import { runStatusCommand, formatJobDetail } from './commands/status.js';
import { SpatulaApiClient } from './api/client.js';

const DEFAULT_API_URL = 'http://localhost:3000';

function getEnvOrFail(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function getApiClient(argv: { apiUrl?: string; tenantId?: string }): SpatulaApiClient {
  const apiUrl = argv.apiUrl ?? process.env.SPATULA_API_URL ?? DEFAULT_API_URL;
  const tenantId = argv.tenantId ?? getEnvOrFail('SPATULA_TENANT_ID');
  return new SpatulaApiClient(apiUrl, tenantId);
}

yargs(hideBin(process.argv))
  .scriptName('spatula')
  .option('api-url', {
    type: 'string',
    description: 'API server URL',
    default: DEFAULT_API_URL,
  })
  .option('tenant-id', {
    type: 'string',
    description: 'Tenant ID (or set SPATULA_TENANT_ID)',
  })
  .command(
    'new',
    'Create a new crawl job interactively',
    (yargs) =>
      yargs.option('model', {
        type: 'string',
        description: 'LLM model for config conversation',
        default: 'anthropic/claude-sonnet-4-20250514',
      }),
    async (argv) => {
      const tenantId = argv.tenantId ?? getEnvOrFail('SPATULA_TENANT_ID');
      const openrouterKey = getEnvOrFail('OPENROUTER_API_KEY');

      await runNewCommand({
        apiUrl: argv.apiUrl ?? DEFAULT_API_URL,
        tenantId,
        openrouterApiKey: openrouterKey,
        model: argv.model,
      });
    },
  )
  .command(
    'list',
    'List crawl jobs',
    (yargs) =>
      yargs
        .option('status', {
          type: 'string',
          description: 'Filter by status',
          choices: [
            'pending',
            'queued',
            'running',
            'paused',
            'reconciling',
            'completed',
            'failed',
            'cancelled',
          ],
        })
        .option('limit', {
          type: 'number',
          description: 'Maximum number of jobs',
          default: 50,
        }),
    async (argv) => {
      const client = getApiClient(argv);
      const jobs = await runListCommand(client, {
        status: argv.status,
        limit: argv.limit,
      });
      console.log(formatJobsTable(jobs));
    },
  )
  .command(
    'status <jobId>',
    'Show job details',
    (yargs) =>
      yargs.positional('jobId', {
        type: 'string',
        description: 'Job ID',
        demandOption: true,
      }),
    async (argv) => {
      const client = getApiClient(argv);
      const job = await runStatusCommand(client, argv.jobId as string);
      console.log(formatJobDetail(job));
    },
  )
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help()
  .parse();
```

**Step 5: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --run tests/unit/commands/
```

Expected: All tests PASS.

**Step 6: Commit**

```bash
git add apps/cli/src/index.tsx apps/cli/src/commands/ apps/cli/tests/unit/commands/
git commit -m "feat(cli): add yargs CLI entry point with new, list, and status commands"
```

---

## Task 11: Full Build Verification + Barrel Exports

**Files:**

- Modify: `apps/cli/src/index.tsx` (ensure shebang for bin)
- Verify: all packages build

**Step 1: Run full monorepo build**

```bash
pnpm -r build
```

Expected: All packages build successfully including `@spatula/cli`.

**Step 2: Run all tests across the monorepo**

```bash
pnpm test
```

Expected: All tests pass across all packages. The CLI should have tests passing for:

- `tests/unit/api/client.test.ts`
- `tests/unit/store/index.test.ts`
- `tests/unit/components/shared/*.test.tsx`
- `tests/unit/components/conversational/*.test.tsx`
- `tests/unit/components/app.test.tsx`
- `tests/unit/commands/*.test.ts`
- `tests/unit/services/config-conversation.test.ts`

Plus all core tests including the new `tests/unit/config/config-executor.test.ts`.

**Step 3: Verify CLI help output**

```bash
cd apps/cli && npx tsx src/index.tsx --help
```

Expected: Shows help with `new`, `list`, `status` commands.

**Step 4: Verify TypeScript strict compliance**

```bash
pnpm -r typecheck 2>&1 || cd apps/cli && npx tsc --noEmit
```

Expected: No type errors.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(cli): Phase 9a complete — CLI core + conversational mode with full test suite"
```

---

## Summary

**Phase 9a delivers:**

- 11 tasks following TDD workflow
- `DefaultConfigExecutor` in core (all 30 ConfigAction types)
- `SpatulaApiClient` HTTP wrapper for all Phase 8 endpoints
- Zustand store with config state, chat messages, and mode management
- Ink shared components (Panel, Header, Spinner, KeyboardHints)
- ConfigPanel for displaying evolving job config
- ChatView with message display and text input
- `ConfigConversationService` for LLM-powered config building
- App root with mode routing (conversational active, others stubbed)
- CLI entry point with `new`, `list`, `status` commands via yargs
- Full test suite covering all modules

**Deliverable:** `spatula new` launches conversational mode where users describe crawls, LLM produces ConfigActions, config panel updates live, and confirmed jobs are created and started via the API.

**Next:** Phase 9b (Dashboard + Review Mode) and Phase 9c (Results Explorer) build on this foundation.
