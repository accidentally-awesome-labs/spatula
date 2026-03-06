# Phase 1: Project Foundation & Core Types — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold the Spatula monorepo and implement all core Zod type schemas, shared utilities, and core interfaces so that subsequent phases have a type-safe, tested foundation to build on.

**Architecture:** Turborepo + pnpm monorepo with 4 packages (`shared`, `core`, `db`, `queue`) and 2 apps (`api`, `cli`). Phase 1 implements `shared` and the `types/` + `interfaces/` layers of `core`. Database, queue, and app packages get placeholder `package.json` only.

**Tech Stack:** TypeScript 5.x, pnpm workspaces, Turborepo, Zod, Vitest, ESLint, Prettier

---

## Task 1: Initialize Monorepo Scaffolding

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.npmrc`
- Create: `.gitignore`
- Create: `.env.example`

**Step 1: Initialize pnpm workspace root**

```bash
cd /Users/salar/Projects/spatula
pnpm init
```

Then replace `package.json` with:

```json
{
  "name": "spatula",
  "private": true,
  "packageManager": "pnpm@9.15.4",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "test:watch": "turbo run test:watch",
    "lint": "turbo run lint",
    "lint:fix": "turbo run lint:fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "clean": "turbo run clean",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0",
    "prettier": "^3.4.0",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "@typescript-eslint/parser": "^8.18.0",
    "eslint": "^9.16.0"
  }
}
```

**Step 2: Create workspace config files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "test:watch": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "lint:fix": {},
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "exclude": ["node_modules", "dist"]
}
```

`.npmrc`:
```
auto-install-peers=true
```

`.gitignore`:
```
node_modules/
dist/
.turbo/
*.tsbuildinfo
.env
.env.local
coverage/
```

`.env.example`:
```
# OpenRouter
OPENROUTER_API_KEY=

# Database
DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula

# Redis
REDIS_URL=redis://localhost:6379

# Firecrawl (optional)
FIRECRAWL_API_KEY=
```

**Step 3: Install root dependencies**

Run: `pnpm install`

**Step 4: Verify turbo works**

Run: `pnpm turbo --version`
Expected: Version output (2.x)

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: initialize monorepo with Turborepo + pnpm workspaces"
```

---

## Task 2: Create Package Scaffolds

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/db/package.json`
- Create: `packages/db/src/index.ts`
- Create: `packages/queue/package.json`
- Create: `packages/queue/src/index.ts`
- Create: `apps/api/package.json`
- Create: `apps/api/src/index.ts`
- Create: `apps/cli/package.json`
- Create: `apps/cli/src/index.ts`

**Step 1: Create shared package**

`packages/shared/package.json`:
```json
{
  "name": "@spatula/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "zod": "^3.24.0",
    "pino": "^9.6.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`packages/shared/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

`packages/shared/src/index.ts`:
```typescript
export * from './logger.js';
export * from './errors.js';
export * from './config.js';
export * from './utils.js';
```

**Step 2: Create core package**

`packages/core/package.json`:
```json
{
  "name": "@spatula/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@spatula/shared": "workspace:*",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../shared" }
  ]
}
```

`packages/core/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

`packages/core/src/index.ts`:
```typescript
// Types
export * from './types/index.js';

// Interfaces
export * from './interfaces/index.js';
```

**Step 3: Create placeholder packages (db, queue, api, cli)**

`packages/db/package.json`:
```json
{
  "name": "@spatula/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@spatula/shared": "workspace:*",
    "@spatula/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/db/src/index.ts`:
```typescript
// Phase 4: Database layer
```

`packages/queue/package.json`:
```json
{
  "name": "@spatula/queue",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@spatula/shared": "workspace:*",
    "@spatula/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/queue/src/index.ts`:
```typescript
// Phase 5: Queue layer
```

`apps/api/package.json`:
```json
{
  "name": "@spatula/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@spatula/core": "workspace:*",
    "@spatula/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0"
  }
}
```

`apps/api/src/index.ts`:
```typescript
// Phase 8: API server
```

`apps/cli/package.json`:
```json
{
  "name": "@spatula/cli",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.tsx",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@spatula/core": "workspace:*",
    "@spatula/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0"
  }
}
```

`apps/cli/src/index.ts`:
```typescript
// Phase 9: CLI
```

Create `tsconfig.json` for each placeholder package (db, queue) — same pattern as shared but with appropriate references. Api and cli get similar configs.

**Step 4: Install all dependencies**

Run: `pnpm install`

**Step 5: Verify workspace resolution**

Run: `pnpm ls --filter @spatula/core`
Expected: Shows `@spatula/shared` as a dependency linked via workspace

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold all package and app directories"
```

---

## Task 3: Shared Package — Logger

**Files:**
- Create: `packages/shared/src/logger.ts`
- Create: `packages/shared/tests/logger.test.ts`

**Step 1: Write the failing test**

`packages/shared/tests/logger.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  it('creates a logger with a given name', () => {
    const logger = createLogger('test-module');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('creates a child logger', () => {
    const logger = createLogger('parent');
    const child = logger.child({ component: 'child' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test`
Expected: FAIL — cannot resolve `../src/logger.js`

**Step 3: Write minimal implementation**

`packages/shared/src/logger.ts`:
```typescript
import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}
```

**Step 4: Install pino-pretty for dev**

Run: `cd packages/shared && pnpm add -D pino-pretty`

**Step 5: Run test to verify it passes**

Run: `cd packages/shared && pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/shared/src/logger.ts packages/shared/tests/logger.test.ts packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): add pino-based logger"
```

---

## Task 4: Shared Package — Error Classes

**Files:**
- Create: `packages/shared/src/errors.ts`
- Create: `packages/shared/tests/errors.test.ts`

**Step 1: Write the failing test**

`packages/shared/tests/errors.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  SpatulaError,
  ValidationError,
  CrawlError,
  ExtractionError,
  LLMError,
  ConfigError,
  StorageError,
} from '../src/errors.js';

describe('SpatulaError', () => {
  it('is an instance of Error', () => {
    const err = new SpatulaError('test', 'TEST_ERROR');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpatulaError);
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST_ERROR');
    expect(err.name).toBe('SpatulaError');
  });

  it('supports optional cause', () => {
    const cause = new Error('root');
    const err = new SpatulaError('wrapper', 'WRAP', { cause });
    expect(err.cause).toBe(cause);
  });

  it('supports optional context', () => {
    const err = new SpatulaError('test', 'TEST', { context: { jobId: '123' } });
    expect(err.context).toEqual({ jobId: '123' });
  });
});

describe('error subclasses', () => {
  it('ValidationError has correct name and code prefix', () => {
    const err = new ValidationError('bad input');
    expect(err.name).toBe('ValidationError');
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('CrawlError has correct name', () => {
    const err = new CrawlError('timeout', { context: { url: 'http://example.com' } });
    expect(err.name).toBe('CrawlError');
    expect(err.code).toBe('CRAWL_ERROR');
    expect(err.context).toEqual({ url: 'http://example.com' });
  });

  it('ExtractionError has correct name', () => {
    expect(new ExtractionError('fail').name).toBe('ExtractionError');
  });

  it('LLMError has correct name', () => {
    expect(new LLMError('rate limit').name).toBe('LLMError');
  });

  it('ConfigError has correct name', () => {
    expect(new ConfigError('missing key').name).toBe('ConfigError');
  });

  it('StorageError has correct name', () => {
    expect(new StorageError('connection lost').name).toBe('StorageError');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test`
Expected: FAIL

**Step 3: Write minimal implementation**

`packages/shared/src/errors.ts`:
```typescript
export interface SpatulaErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}

export class SpatulaError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, options?: SpatulaErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = 'SpatulaError';
    this.code = code;
    this.context = options?.context;
  }
}

export class ValidationError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'VALIDATION_ERROR', options);
    this.name = 'ValidationError';
  }
}

export class CrawlError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'CRAWL_ERROR', options);
    this.name = 'CrawlError';
  }
}

export class ExtractionError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'EXTRACTION_ERROR', options);
    this.name = 'ExtractionError';
  }
}

export class LLMError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'LLM_ERROR', options);
    this.name = 'LLMError';
  }
}

export class ConfigError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'CONFIG_ERROR', options);
    this.name = 'ConfigError';
  }
}

export class StorageError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'STORAGE_ERROR', options);
    this.name = 'StorageError';
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/errors.ts packages/shared/tests/errors.test.ts
git commit -m "feat(shared): add error class hierarchy"
```

---

## Task 5: Shared Package — Config & Utils

**Files:**
- Create: `packages/shared/src/config.ts`
- Create: `packages/shared/src/utils.ts`
- Create: `packages/shared/tests/config.test.ts`
- Create: `packages/shared/tests/utils.test.ts`

**Step 1: Write the failing tests**

`packages/shared/tests/config.test.ts`:
```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEnvOrThrow, getEnvOrDefault } from '../src/config.js';

describe('getEnvOrThrow', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the value if set', () => {
    vi.stubEnv('TEST_KEY', 'test_value');
    expect(getEnvOrThrow('TEST_KEY')).toBe('test_value');
  });

  it('throws if not set', () => {
    expect(() => getEnvOrThrow('MISSING_KEY')).toThrow('MISSING_KEY');
  });
});

describe('getEnvOrDefault', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the value if set', () => {
    vi.stubEnv('TEST_KEY', 'real_value');
    expect(getEnvOrDefault('TEST_KEY', 'default')).toBe('real_value');
  });

  it('returns default if not set', () => {
    expect(getEnvOrDefault('MISSING_KEY', 'fallback')).toBe('fallback');
  });
});
```

`packages/shared/tests/utils.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateId, sleep, chunk, extractDomain } from '../src/utils.js';

describe('generateId', () => {
  it('returns a valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('sleep', () => {
  it('resolves after the given ms', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('chunk', () => {
  it('splits array into chunks of given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns single chunk if array is smaller than size', () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('returns empty array for empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('extractDomain', () => {
  it('extracts domain from full URL', () => {
    expect(extractDomain('https://www.head-fi.org/threads/123')).toBe('head-fi.org');
  });

  it('strips www prefix', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com');
  });

  it('handles URLs without www', () => {
    expect(extractDomain('https://api.example.com/v1')).toBe('api.example.com');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm test`
Expected: FAIL

**Step 3: Write implementations**

`packages/shared/src/config.ts`:
```typescript
import { ConfigError } from './errors.js';

export function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new ConfigError(`Required environment variable ${key} is not set`);
  }
  return value;
}

export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}
```

`packages/shared/src/utils.ts`:
```typescript
import { randomUUID } from 'node:crypto';

export function generateId(): string {
  return randomUUID();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export function extractDomain(url: string): string {
  const hostname = new URL(url).hostname;
  return hostname.replace(/^www\./, '');
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm test`
Expected: PASS (all tests in shared package)

**Step 5: Build shared package**

Run: `cd packages/shared && pnpm build`
Expected: Compiles to `dist/` with no errors

**Step 6: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add config helpers and utility functions"
```

---

## Task 6: Core Types — Normalization Rules

**Files:**
- Create: `packages/core/src/types/normalization.ts`
- Create: `packages/core/tests/unit/types/normalization.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/types/normalization.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { NormalizationRule } from '../../../src/types/normalization.js';

describe('NormalizationRule', () => {
  it('parses a currency normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'currency',
      config: { targetCurrency: 'USD', decimalPlaces: 2 },
    });
    expect(result.type).toBe('currency');
    expect(result.config.targetCurrency).toBe('USD');
  });

  it('parses an enum normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'enum',
      config: {
        canonicalValues: ['over-ear', 'on-ear', 'in-ear'],
        synonymMap: { circumaural: 'over-ear', 'Over Ear': 'over-ear' },
      },
    });
    expect(result.type).toBe('enum');
    expect(result.config.synonymMap['circumaural']).toBe('over-ear');
  });

  it('parses a text normalization rule with defaults', () => {
    const result = NormalizationRule.parse({
      type: 'text',
      config: {},
    });
    expect(result.config.casing).toBe('title');
    expect(result.config.trim).toBe(true);
  });

  it('parses a boolean normalization rule with defaults', () => {
    const result = NormalizationRule.parse({
      type: 'boolean',
      config: {},
    });
    expect(result.config.trueValues).toContain('yes');
    expect(result.config.falseValues).toContain('no');
  });

  it('parses a measurement normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'measurement',
      config: { targetUnit: 'g' },
    });
    expect(result.config.targetUnit).toBe('g');
  });

  it('parses a list normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'list',
      config: { separator: ',' },
    });
    expect(result.type).toBe('list');
  });

  it('parses an llm normalization rule', () => {
    const result = NormalizationRule.parse({
      type: 'llm',
      config: { instruction: 'Normalize to ISO 8601' },
    });
    expect(result.config.instruction).toBe('Normalize to ISO 8601');
  });

  it('rejects invalid type', () => {
    expect(() =>
      NormalizationRule.parse({ type: 'invalid', config: {} })
    ).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/types/normalization.ts`:
```typescript
import { z } from 'zod';

const CurrencyNormalization = z.object({
  type: z.literal('currency'),
  config: z.object({
    targetCurrency: z.string().optional(),
    decimalPlaces: z.number().default(2),
  }),
});

const EnumNormalization = z.object({
  type: z.literal('enum'),
  config: z.object({
    canonicalValues: z.array(z.string()),
    synonymMap: z.record(z.string()),
  }),
});

const ListNormalization = z.object({
  type: z.literal('list'),
  config: z.object({
    separator: z.string().optional(),
    // Note: recursive itemNormalization deferred to avoid circular ref complexity
  }),
});

const TextNormalization = z.object({
  type: z.literal('text'),
  config: z.object({
    casing: z.enum(['title', 'lower', 'upper', 'preserve']).default('title'),
    trim: z.boolean().default(true),
    collapseWhitespace: z.boolean().default(true),
  }),
});

const MeasurementNormalization = z.object({
  type: z.literal('measurement'),
  config: z.object({
    targetUnit: z.string().optional(),
    format: z.string().optional(),
  }),
});

const BooleanNormalization = z.object({
  type: z.literal('boolean'),
  config: z.object({
    trueValues: z.array(z.string()).default(['yes', 'true', '1', 'available']),
    falseValues: z.array(z.string()).default(['no', 'false', '0', 'unavailable']),
  }),
});

const LLMNormalization = z.object({
  type: z.literal('llm'),
  config: z.object({
    instruction: z.string(),
  }),
});

export const NormalizationRule = z.discriminatedUnion('type', [
  CurrencyNormalization,
  EnumNormalization,
  ListNormalization,
  TextNormalization,
  MeasurementNormalization,
  BooleanNormalization,
  LLMNormalization,
]);

export type NormalizationRule = z.infer<typeof NormalizationRule>;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/normalization.ts packages/core/tests/
git commit -m "feat(core): add NormalizationRule Zod schemas (7 types)"
```

---

## Task 7: Core Types — Field & Schema Definitions

**Files:**
- Create: `packages/core/src/types/schema.ts`
- Create: `packages/core/tests/unit/types/schema.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/types/schema.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  FieldDefinition,
  FieldRelevance,
  FieldAlias,
  SchemaDefinition,
} from '../../../src/types/schema.js';

describe('FieldDefinition', () => {
  it('parses a simple string field', () => {
    const result = FieldDefinition.parse({
      name: 'product_name',
      description: 'Name of the product',
      type: 'string',
    });
    expect(result.name).toBe('product_name');
    expect(result.required).toBe(false); // default
  });

  it('parses a required currency field with normalization', () => {
    const result = FieldDefinition.parse({
      name: 'price',
      description: 'Product price',
      type: 'currency',
      required: true,
      normalization: {
        type: 'currency',
        config: { targetCurrency: 'USD' },
      },
    });
    expect(result.required).toBe(true);
    expect(result.normalization?.type).toBe('currency');
  });

  it('parses an enum field with values', () => {
    const result = FieldDefinition.parse({
      name: 'device_type',
      description: 'Type of audio device',
      type: 'enum',
      enumValues: ['headphone', 'iem', 'dac', 'amplifier'],
    });
    expect(result.enumValues).toHaveLength(4);
  });

  it('parses a nested object field', () => {
    const result = FieldDefinition.parse({
      name: 'specs',
      description: 'Technical specifications',
      type: 'object',
      objectFields: [
        { name: 'impedance', description: 'Impedance in ohms', type: 'number' },
        { name: 'weight', description: 'Weight', type: 'string' },
      ],
    });
    expect(result.objectFields).toHaveLength(2);
  });

  it('parses an array field', () => {
    const result = FieldDefinition.parse({
      name: 'images',
      description: 'Product image URLs',
      type: 'array',
      arrayItemType: {
        name: 'image_url',
        description: 'Single image URL',
        type: 'url',
      },
    });
    expect(result.arrayItemType?.type).toBe('url');
  });

  it('rejects invalid type', () => {
    expect(() =>
      FieldDefinition.parse({ name: 'x', description: 'x', type: 'invalid' })
    ).toThrow();
  });
});

describe('FieldRelevance', () => {
  it('parses a universal required field', () => {
    const result = FieldRelevance.parse({
      globalFrequency: 0.95,
      categoryBreakdown: [],
      classification: 'universal_required',
      applicableCategories: null,
    });
    expect(result.classification).toBe('universal_required');
  });

  it('parses a categorical field with breakdown', () => {
    const result = FieldRelevance.parse({
      globalFrequency: 0.4,
      categoryBreakdown: [
        { category: 'headphone', frequency: 0.98, sampleSize: 63 },
        { category: 'iem', frequency: 0.95, sampleSize: 28 },
      ],
      classification: 'categorical_required',
      applicableCategories: ['headphone', 'iem'],
    });
    expect(result.categoryBreakdown).toHaveLength(2);
    expect(result.applicableCategories).toContain('headphone');
  });
});

describe('FieldAlias', () => {
  it('parses a field alias mapping', () => {
    const result = FieldAlias.parse({
      canonicalName: 'price',
      aliases: [
        { name: 'retail_price', sources: ['amazon.com'], occurrences: 47 },
        { name: 'msrp', sources: ['sennheiser.com'], occurrences: 12 },
      ],
      mergedAt: new Date().toISOString(),
      reasoning: 'Both represent product selling price',
    });
    expect(result.aliases).toHaveLength(2);
  });
});

describe('SchemaDefinition', () => {
  it('parses a complete schema definition', () => {
    const result = SchemaDefinition.parse({
      version: 3,
      fields: [
        { name: 'name', description: 'Product name', type: 'string', required: true },
        { name: 'price', description: 'Price', type: 'currency' },
      ],
      fieldAliases: [],
      createdAt: new Date().toISOString(),
      parentVersion: 2,
    });
    expect(result.version).toBe(3);
    expect(result.fields).toHaveLength(2);
    expect(result.parentVersion).toBe(2);
  });

  it('allows null parentVersion for initial schema', () => {
    const result = SchemaDefinition.parse({
      version: 1,
      fields: [],
      fieldAliases: [],
      createdAt: new Date().toISOString(),
      parentVersion: null,
    });
    expect(result.parentVersion).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/types/schema.ts`:
```typescript
import { z } from 'zod';
import { NormalizationRule } from './normalization.js';

export const FieldDefinition: z.ZodType<{
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'url' | 'currency' | 'enum' | 'array' | 'object';
  required: boolean;
  normalization?: z.infer<typeof NormalizationRule>;
  enumValues?: string[];
  arrayItemType?: unknown;
  objectFields?: unknown[];
}> = z.lazy(() =>
  z.object({
    name: z.string(),
    description: z.string(),
    type: z.enum([
      'string', 'number', 'boolean', 'url',
      'currency', 'enum', 'array', 'object',
    ]),
    required: z.boolean().default(false),
    normalization: NormalizationRule.optional(),
    enumValues: z.array(z.string()).optional(),
    arrayItemType: FieldDefinition.optional(),
    objectFields: z.array(FieldDefinition).optional(),
  })
);

export type FieldDefinition = z.infer<typeof FieldDefinition>;

export const FieldRelevance = z.object({
  globalFrequency: z.number(),
  categoryBreakdown: z.array(
    z.object({
      category: z.string(),
      frequency: z.number(),
      sampleSize: z.number(),
    })
  ),
  classification: z.enum([
    'universal_required',
    'universal_optional',
    'categorical_required',
    'categorical_optional',
    'rare',
  ]),
  applicableCategories: z.array(z.string()).nullable(),
});

export type FieldRelevance = z.infer<typeof FieldRelevance>;

export const FieldAlias = z.object({
  canonicalName: z.string(),
  aliases: z.array(
    z.object({
      name: z.string(),
      sources: z.array(z.string()),
      occurrences: z.number(),
    })
  ),
  mergedAt: z.coerce.date(),
  reasoning: z.string(),
});

export type FieldAlias = z.infer<typeof FieldAlias>;

export const SchemaDefinition = z.object({
  version: z.number(),
  fields: z.array(FieldDefinition),
  fieldAliases: z.array(FieldAlias),
  createdAt: z.coerce.date(),
  parentVersion: z.number().nullable(),
});

export type SchemaDefinition = z.infer<typeof SchemaDefinition>;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/schema.ts packages/core/tests/
git commit -m "feat(core): add FieldDefinition, FieldRelevance, SchemaDefinition types"
```

---

## Task 8: Core Types — Job Configuration

**Files:**
- Create: `packages/core/src/types/job.ts`
- Create: `packages/core/tests/unit/types/job.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/types/job.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { JobConfig, JobStatus } from '../../../src/types/job.js';

describe('JobConfig', () => {
  const validConfig = {
    tenantId: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Audiophile Products',
    description: 'Crawl audiophile product data',
    seedUrls: ['https://head-fi.org', 'https://audiosciencereview.com'],
    crawl: {
      maxDepth: 2,
      maxPages: 5000,
      concurrency: 5,
      crawlerType: 'playwright' as const,
    },
    schema: {
      mode: 'hybrid' as const,
      userFields: [
        { name: 'name', description: 'Product name', type: 'string' as const, required: true },
        { name: 'price', description: 'Price', type: 'currency' as const },
      ],
      evolutionConfig: {
        enabled: true,
        batchSize: 10,
        maxFields: 50,
        relevanceThresholds: {
          requiredMin: 0.85,
          optionalMin: 0.40,
          rareBelow: 0.40,
          minCategorySampleSize: 5,
        },
        tableStrategy: 'auto' as const,
      },
    },
    llm: {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
      modelOverrides: {
        pageRelevance: 'anthropic/claude-haiku-4-5-20251001',
        linkEvaluation: 'anthropic/claude-haiku-4-5-20251001',
      },
    },
  };

  it('parses a complete valid config', () => {
    const result = JobConfig.parse(validConfig);
    expect(result.name).toBe('Audiophile Products');
    expect(result.seedUrls).toHaveLength(2);
    expect(result.schema.mode).toBe('hybrid');
    expect(result.schema.evolutionConfig?.batchSize).toBe(10);
  });

  it('applies defaults for crawl settings', () => {
    const minimal = {
      ...validConfig,
      crawl: {},
    };
    const result = JobConfig.parse(minimal);
    expect(result.crawl.maxDepth).toBe(2);
    expect(result.crawl.maxPages).toBe(1000);
    expect(result.crawl.concurrency).toBe(5);
    expect(result.crawl.crawlerType).toBe('playwright');
  });

  it('applies default LLM model', () => {
    const result = JobConfig.parse({
      ...validConfig,
      llm: {},
    });
    expect(result.llm.primaryModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('rejects invalid seed URLs', () => {
    expect(() =>
      JobConfig.parse({ ...validConfig, seedUrls: ['not-a-url'] })
    ).toThrow();
  });

  it('rejects invalid tenant UUID', () => {
    expect(() =>
      JobConfig.parse({ ...validConfig, tenantId: 'not-a-uuid' })
    ).toThrow();
  });

  it('rejects crawl depth over 10', () => {
    expect(() =>
      JobConfig.parse({
        ...validConfig,
        crawl: { ...validConfig.crawl, maxDepth: 11 },
      })
    ).toThrow();
  });

  it('allows discovery mode without userFields', () => {
    const result = JobConfig.parse({
      ...validConfig,
      schema: { mode: 'discovery' },
    });
    expect(result.schema.userFields).toBeUndefined();
  });
});

describe('JobStatus', () => {
  it('accepts all valid statuses', () => {
    const statuses = [
      'pending', 'queued', 'running', 'paused',
      'reconciling', 'completed', 'failed', 'cancelled',
    ];
    for (const status of statuses) {
      expect(JobStatus.parse(status)).toBe(status);
    }
  });

  it('rejects invalid status', () => {
    expect(() => JobStatus.parse('unknown')).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/types/job.ts`:
```typescript
import { z } from 'zod';
import { FieldDefinition } from './schema.js';

export const RelevanceThresholds = z.object({
  requiredMin: z.number().default(0.85),
  optionalMin: z.number().default(0.40),
  rareBelow: z.number().default(0.40),
  minCategorySampleSize: z.number().default(5),
});

export type RelevanceThresholds = z.infer<typeof RelevanceThresholds>;

export const EvolutionConfig = z.object({
  enabled: z.boolean(),
  batchSize: z.number().default(10),
  maxFields: z.number().default(50),
  relevanceThresholds: RelevanceThresholds.default({}),
  tableStrategy: z.enum(['single', 'multi', 'auto']).default('auto'),
});

export type EvolutionConfig = z.infer<typeof EvolutionConfig>;

export const CrawlConfig = z.object({
  maxDepth: z.number().min(0).max(10).default(2),
  maxPages: z.number().min(1).default(1000),
  concurrency: z.number().min(1).max(20).default(5),
  crawlerType: z.enum(['playwright', 'firecrawl']).default('playwright'),
});

export type CrawlConfig = z.infer<typeof CrawlConfig>;

export const SchemaConfig = z.object({
  mode: z.enum(['fixed', 'discovery', 'hybrid']),
  userFields: z.array(FieldDefinition).optional(),
  evolutionConfig: EvolutionConfig.optional(),
});

export type SchemaConfig = z.infer<typeof SchemaConfig>;

export const LLMModelOverrides = z.object({
  pageRelevance: z.string().optional(),
  extraction: z.string().optional(),
  linkEvaluation: z.string().optional(),
  schemaEvolution: z.string().optional(),
  entityMatching: z.string().optional(),
  conflictResolution: z.string().optional(),
  qualityAudit: z.string().optional(),
  documentation: z.string().optional(),
});

export type LLMModelOverrides = z.infer<typeof LLMModelOverrides>;

export const LLMConfig = z.object({
  primaryModel: z.string().default('anthropic/claude-sonnet-4-20250514'),
  modelOverrides: LLMModelOverrides.optional(),
});

export type LLMConfig = z.infer<typeof LLMConfig>;

export const EntityMatchStrategy = z.enum([
  'exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted',
]);

export type EntityMatchStrategy = z.infer<typeof EntityMatchStrategy>;

export const ConflictResolution = z.enum([
  'most_common', 'most_complete', 'source_priority', 'most_recent', 'llm_resolved',
]);

export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const ReconciliationConfig = z.object({
  matchStrategy: EntityMatchStrategy.default('composite_key'),
  conflictResolution: ConflictResolution.default('most_complete'),
  sourcePriority: z.array(z.string()).optional(),
  fuzzyMatchThreshold: z.number().default(0.85),
  enableLLMMatching: z.boolean().default(true),
});

export type ReconciliationConfig = z.infer<typeof ReconciliationConfig>;

export const JobConfig = z.object({
  tenantId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  seedUrls: z.array(z.string().url()),
  crawl: CrawlConfig.default({}),
  schema: SchemaConfig,
  llm: LLMConfig.default({}),
  reconciliation: ReconciliationConfig.optional(),
});

export type JobConfig = z.infer<typeof JobConfig>;

export const JobStatus = z.enum([
  'pending', 'queued', 'running', 'paused',
  'reconciling', 'completed', 'failed', 'cancelled',
]);

export type JobStatus = z.infer<typeof JobStatus>;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/job.ts packages/core/tests/
git commit -m "feat(core): add JobConfig, ReconciliationConfig, and related types"
```

---

## Task 9: Core Types — Extraction Types

**Files:**
- Create: `packages/core/src/types/extraction.ts`
- Create: `packages/core/tests/unit/types/extraction.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/types/extraction.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { ExtractionResult, ValueProvenance, PageClassification } from '../../../src/types/extraction.js';

describe('ExtractionResult', () => {
  it('parses a valid extraction result', () => {
    const result = ExtractionResult.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      jobId: '550e8400-e29b-41d4-a716-446655440001',
      pageId: '550e8400-e29b-41d4-a716-446655440002',
      schemaVersion: 3,
      data: {
        name: 'Sennheiser HD 650',
        price: { amount: 299, currency: 'USD' },
      },
      metadata: {
        confidence: 0.92,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 1450,
        extractionTimeMs: 2300,
        unmappedFields: [
          { name: 'warranty', value: '2 years', suggestedType: 'string' },
        ],
      },
    });
    expect(result.schemaVersion).toBe(3);
    expect(result.metadata.unmappedFields).toHaveLength(1);
  });

  it('rejects confidence outside 0-1 range', () => {
    expect(() =>
      ExtractionResult.parse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        jobId: '550e8400-e29b-41d4-a716-446655440001',
        pageId: '550e8400-e29b-41d4-a716-446655440002',
        schemaVersion: 1,
        data: {},
        metadata: {
          confidence: 1.5,
          modelUsed: 'test',
          tokensUsed: 0,
          extractionTimeMs: 0,
          unmappedFields: [],
        },
      })
    ).toThrow();
  });
});

describe('ValueProvenance', () => {
  it('accepts all valid provenance types', () => {
    const types = ['extracted', 'normalized', 'merged', 'resolved', 'inferred'];
    for (const t of types) {
      expect(ValueProvenance.parse(t)).toBe(t);
    }
  });
});

describe('PageClassification', () => {
  it('accepts all valid classifications', () => {
    const types = ['single_entry', 'multiple_entries', 'navigation', 'irrelevant', 'partial'];
    for (const t of types) {
      expect(PageClassification.parse(t)).toBe(t);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/types/extraction.ts`:
```typescript
import { z } from 'zod';

export const UnmappedField = z.object({
  name: z.string(),
  value: z.unknown(),
  suggestedType: z.string(),
});

export type UnmappedField = z.infer<typeof UnmappedField>;

export const ExtractionMetadata = z.object({
  confidence: z.number().min(0).max(1),
  modelUsed: z.string(),
  tokensUsed: z.number(),
  extractionTimeMs: z.number(),
  unmappedFields: z.array(UnmappedField),
});

export type ExtractionMetadata = z.infer<typeof ExtractionMetadata>;

export const ExtractionResult = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  pageId: z.string().uuid(),
  schemaVersion: z.number(),
  data: z.record(z.unknown()),
  metadata: ExtractionMetadata,
});

export type ExtractionResult = z.infer<typeof ExtractionResult>;

export const ValueProvenance = z.enum([
  'extracted', 'normalized', 'merged', 'resolved', 'inferred',
]);

export type ValueProvenance = z.infer<typeof ValueProvenance>;

export const PageClassification = z.enum([
  'single_entry', 'multiple_entries', 'navigation', 'irrelevant', 'partial',
]);

export type PageClassification = z.infer<typeof PageClassification>;

export const ExtractionStrategy = z.enum([
  'full_extraction', 'list_extraction', 'links_only', 'skip',
]);

export type ExtractionStrategy = z.infer<typeof ExtractionStrategy>;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/extraction.ts packages/core/tests/
git commit -m "feat(core): add ExtractionResult, ValueProvenance types"
```

---

## Task 10: Core Types — Reconciliation Types

**Files:**
- Create: `packages/core/src/types/reconciliation.ts`
- Create: `packages/core/tests/unit/types/reconciliation.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/types/reconciliation.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { EntityMatch, SourceTrust, TrustLevel } from '../../../src/types/reconciliation.js';

describe('EntityMatch', () => {
  it('parses a complete entity match', () => {
    const result = EntityMatch.parse({
      entityId: '550e8400-e29b-41d4-a716-446655440000',
      sourceExtractions: [
        {
          extractionId: '550e8400-e29b-41d4-a716-446655440001',
          sourceUrl: 'https://amazon.com/hd650',
          sourceDomain: 'amazon.com',
          crawledAt: new Date().toISOString(),
          fieldsCovered: ['name', 'price'],
        },
        {
          extractionId: '550e8400-e29b-41d4-a716-446655440002',
          sourceUrl: 'https://head-fi.org/hd650',
          sourceDomain: 'head-fi.org',
          crawledAt: new Date().toISOString(),
          fieldsCovered: ['name', 'driver_type', 'impedance'],
        },
      ],
      mergedData: {
        name: 'Sennheiser HD 650',
        price: { amount: 299, currency: 'USD' },
        driver_type: 'dynamic',
        impedance: '300',
      },
      fieldProvenance: {
        name: {
          finalValue: 'Sennheiser HD 650',
          provenanceType: 'extracted',
          sources: [
            { sourceUrl: 'https://amazon.com/hd650', rawValue: 'Sennheiser HD 650', normalizedValue: 'Sennheiser HD 650' },
          ],
          hadConflict: false,
        },
        price: {
          finalValue: { amount: 299, currency: 'USD' },
          provenanceType: 'normalized',
          sources: [
            { sourceUrl: 'https://amazon.com/hd650', rawValue: '$299.00', normalizedValue: { amount: 299, currency: 'USD' } },
          ],
          hadConflict: false,
        },
      },
    });
    expect(result.sourceExtractions).toHaveLength(2);
    expect(result.fieldProvenance['name'].hadConflict).toBe(false);
  });
});

describe('SourceTrust', () => {
  it('parses source trust config', () => {
    const result = SourceTrust.parse({
      domain: 'sennheiser.com',
      trustLevel: 'authoritative',
      reasoning: 'Official manufacturer website',
    });
    expect(result.trustLevel).toBe('authoritative');
  });
});

describe('TrustLevel', () => {
  it('accepts all valid levels', () => {
    for (const level of ['authoritative', 'high', 'medium', 'low']) {
      expect(TrustLevel.parse(level)).toBe(level);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/types/reconciliation.ts`:
```typescript
import { z } from 'zod';
import { ValueProvenance } from './extraction.js';
import { ConflictResolution } from './job.js';

export const TrustLevel = z.enum(['authoritative', 'high', 'medium', 'low']);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const SourceTrust = z.object({
  domain: z.string(),
  trustLevel: TrustLevel,
  reasoning: z.string(),
});

export type SourceTrust = z.infer<typeof SourceTrust>;

export const FieldProvenanceEntry = z.object({
  finalValue: z.unknown(),
  provenanceType: ValueProvenance,
  sources: z.array(
    z.object({
      sourceUrl: z.string(),
      rawValue: z.unknown(),
      normalizedValue: z.unknown(),
    })
  ),
  hadConflict: z.boolean(),
  resolution: ConflictResolution.optional(),
});

export type FieldProvenanceEntry = z.infer<typeof FieldProvenanceEntry>;

export const EntityMatch = z.object({
  entityId: z.string().uuid(),
  sourceExtractions: z.array(
    z.object({
      extractionId: z.string().uuid(),
      sourceUrl: z.string().url(),
      sourceDomain: z.string(),
      crawledAt: z.coerce.date(),
      fieldsCovered: z.array(z.string()),
    })
  ),
  mergedData: z.record(z.unknown()),
  fieldProvenance: z.record(FieldProvenanceEntry),
});

export type EntityMatch = z.infer<typeof EntityMatch>;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/reconciliation.ts packages/core/tests/
git commit -m "feat(core): add EntityMatch, SourceTrust, FieldProvenance types"
```

---

## Task 11: Core Types — Pipeline Actions

**Files:**
- Create: `packages/core/src/types/actions.ts`
- Create: `packages/core/tests/unit/types/actions.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/types/actions.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { PipelineAction, ActionStatus, ActionSource, SafetyPolicy } from '../../../src/types/actions.js';

describe('PipelineAction', () => {
  const base = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    jobId: '550e8400-e29b-41d4-a716-446655440001',
    source: 'schema_evolution' as const,
    reasoning: 'Field observed in 92% of headphone extractions',
    confidence: 0.92,
  };

  it('parses add_field action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'add_field',
      payload: {
        field: { name: 'impedance', description: 'Impedance in ohms', type: 'string' },
        relevance: {
          globalFrequency: 0.4,
          categoryBreakdown: [{ category: 'headphone', frequency: 0.92, sampleSize: 63 }],
          classification: 'categorical_required',
          applicableCategories: ['headphone'],
        },
      },
    });
    expect(result.type).toBe('add_field');
  });

  it('parses merge_fields action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'merge_fields',
      payload: {
        canonicalName: 'price',
        aliasNames: ['retail_price', 'msrp'],
        canonicalDefinition: { name: 'price', description: 'Product price', type: 'currency' },
        valueMappings: {},
      },
    });
    expect(result.type).toBe('merge_fields');
    expect(result.payload.aliasNames).toHaveLength(2);
  });

  it('parses classify_page action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'classify_page',
      payload: {
        pageId: '550e8400-e29b-41d4-a716-446655440003',
        classification: 'single_entry',
        extractionStrategy: 'full_extraction',
      },
    });
    expect(result.payload.classification).toBe('single_entry');
  });

  it('parses match_entities action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'match_entities',
      source: 'reconciliation',
      payload: {
        entityId: '550e8400-e29b-41d4-a716-446655440004',
        extractionIds: [
          '550e8400-e29b-41d4-a716-446655440005',
          '550e8400-e29b-41d4-a716-446655440006',
        ],
        matchedOn: ['name', 'brand'],
      },
    });
    expect(result.payload.extractionIds).toHaveLength(2);
  });

  it('parses flag_anomaly action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'flag_anomaly',
      source: 'quality_audit',
      payload: {
        anomalyType: 'outlier_value',
        description: 'Price $99999 seems too high',
        entityId: '550e8400-e29b-41d4-a716-446655440007',
        fieldName: 'price',
      },
    });
    expect(result.type).toBe('flag_anomaly');
  });

  it('parses generate_documentation action', () => {
    const result = PipelineAction.parse({
      ...base,
      type: 'generate_documentation',
      payload: {
        dataDictionary: [
          {
            fieldName: 'name',
            description: 'Product name',
            exampleValues: ['HD 650', 'LCD-X'],
            coveragePercent: 100,
            sources: ['head-fi.org', 'amazon.com'],
          },
        ],
        categoryBreakdown: [
          { category: 'headphone', count: 63, specificFields: ['driver_type', 'impedance'] },
        ],
        qualitySummary: {
          totalEntities: 142,
          totalSources: 3,
          averageFieldCompleteness: 0.78,
          anomaliesFound: 5,
          anomaliesResolved: 3,
        },
      },
    });
    expect(result.type).toBe('generate_documentation');
  });

  it('rejects invalid action type', () => {
    expect(() =>
      PipelineAction.parse({ ...base, type: 'nonexistent', payload: {} })
    ).toThrow();
  });
});

describe('ActionStatus', () => {
  it('accepts all valid statuses', () => {
    const statuses = ['pending_review', 'approved', 'applied', 'rejected', 'rolled_back'];
    for (const s of statuses) {
      expect(ActionStatus.parse(s)).toBe(s);
    }
  });
});

describe('ActionSource', () => {
  it('accepts all valid sources', () => {
    const sources = ['extraction', 'schema_evolution', 'reconciliation', 'quality_audit'];
    for (const s of sources) {
      expect(ActionSource.parse(s)).toBe(s);
    }
  });
});

describe('SafetyPolicy', () => {
  it('accepts all valid policies', () => {
    const policies = ['always_auto', 'auto_above_threshold', 'always_review', 'batch_review'];
    for (const p of policies) {
      expect(SafetyPolicy.parse(p)).toBe(p);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/types/actions.ts`:
```typescript
import { z } from 'zod';
import { FieldDefinition, FieldRelevance } from './schema.js';
import { PageClassification, ExtractionStrategy } from './extraction.js';
import { TrustLevel } from './reconciliation.js';

export const ActionSource = z.enum([
  'extraction', 'schema_evolution', 'reconciliation', 'quality_audit',
]);
export type ActionSource = z.infer<typeof ActionSource>;

export const ActionStatus = z.enum([
  'pending_review', 'approved', 'applied', 'rejected', 'rolled_back',
]);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const SafetyPolicy = z.enum([
  'always_auto', 'auto_above_threshold', 'always_review', 'batch_review',
]);
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

const BaseAction = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  source: ActionSource,
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

// --- Schema Actions ---

const AddFieldAction = BaseAction.extend({
  type: z.literal('add_field'),
  payload: z.object({
    field: FieldDefinition,
    relevance: FieldRelevance,
    insertAfter: z.string().optional(),
  }),
});

const MergeFieldsAction = BaseAction.extend({
  type: z.literal('merge_fields'),
  payload: z.object({
    canonicalName: z.string(),
    aliasNames: z.array(z.string()),
    canonicalDefinition: FieldDefinition,
    valueMappings: z.record(z.unknown()),
  }),
});

const ModifyFieldAction = BaseAction.extend({
  type: z.literal('modify_field'),
  payload: z.object({
    fieldName: z.string(),
    changes: z.object({
      type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']).optional(),
      required: z.boolean().optional(),
      description: z.string().optional(),
      enumValues: z.array(z.string()).optional(),
    }),
  }),
});

const RemoveFieldAction = BaseAction.extend({
  type: z.literal('remove_field'),
  payload: z.object({
    fieldName: z.string(),
    reason: z.enum(['redundant', 'too_rare', 'merged_into_other', 'irrelevant']),
    mergedInto: z.string().optional(),
  }),
});

const RenameFieldAction = BaseAction.extend({
  type: z.literal('rename_field'),
  payload: z.object({
    currentName: z.string(),
    newName: z.string(),
    updateExistingData: z.boolean().default(true),
  }),
});

const SplitFieldAction = BaseAction.extend({
  type: z.literal('split_field'),
  payload: z.object({
    sourceField: z.string(),
    targetFields: z.array(FieldDefinition),
    splitLogic: z.string(),
    examples: z.array(z.object({
      sourceValue: z.unknown(),
      targetValues: z.record(z.unknown()),
    })),
  }),
});

const GroupFieldsAction = BaseAction.extend({
  type: z.literal('group_fields'),
  payload: z.object({
    targetFieldName: z.string(),
    targetFieldType: z.literal('object'),
    sourceFields: z.array(z.string()),
    mapping: z.record(z.string()),
  }),
});

// --- Normalization Actions ---

const SetNormalizationRuleAction = BaseAction.extend({
  type: z.literal('set_normalization_rule'),
  payload: z.object({
    fieldName: z.string(),
    rule: z.any(), // NormalizationRule — using any to avoid circular import complexity
    examples: z.array(z.object({
      before: z.unknown(),
      after: z.unknown(),
    })),
  }),
});

const UpdateEnumMapAction = BaseAction.extend({
  type: z.literal('update_enum_map'),
  payload: z.object({
    fieldName: z.string(),
    additions: z.record(z.string()),
    newCanonicalValues: z.array(z.string()).optional(),
  }),
});

// --- Category Actions ---

const DefineCategoryAction = BaseAction.extend({
  type: z.literal('define_category'),
  payload: z.object({
    categoryField: z.string(),
    categories: z.array(z.object({
      name: z.string(),
      description: z.string(),
      matchCriteria: z.string(),
    })),
  }),
});

const AssignCategoryFieldsAction = BaseAction.extend({
  type: z.literal('assign_category_fields'),
  payload: z.object({
    category: z.string(),
    requiredFields: z.array(z.string()),
    optionalFields: z.array(z.string()),
  }),
});

// --- Crawl Actions ---

const ClassifyPageAction = BaseAction.extend({
  type: z.literal('classify_page'),
  payload: z.object({
    pageId: z.string().uuid(),
    classification: PageClassification,
    estimatedEntryCount: z.number().optional(),
    extractionStrategy: ExtractionStrategy,
  }),
});

const EnqueueLinksAction = BaseAction.extend({
  type: z.literal('enqueue_links'),
  payload: z.object({
    links: z.array(z.object({
      url: z.string().url(),
      relevanceScore: z.number().min(0).max(1),
      expectedContent: z.enum(['single_entry', 'listing', 'pagination', 'category', 'unknown']),
      priority: z.enum(['high', 'medium', 'low']),
      anchorText: z.string().optional(),
    })),
  }),
});

const HintEntityMatchAction = BaseAction.extend({
  type: z.literal('hint_entity_match'),
  payload: z.object({
    currentExtractionId: z.string().uuid(),
    likelyMatchesPageUrl: z.string().url(),
    matchEvidence: z.string(),
  }),
});

// --- Reconciliation Actions ---

const MatchEntitiesAction = BaseAction.extend({
  type: z.literal('match_entities'),
  payload: z.object({
    entityId: z.string().uuid(),
    extractionIds: z.array(z.string().uuid()),
    matchedOn: z.array(z.string()),
  }),
});

const SplitEntitiesAction = BaseAction.extend({
  type: z.literal('split_entities'),
  payload: z.object({
    entityId: z.string().uuid(),
    newGroups: z.array(z.object({
      extractionIds: z.array(z.string().uuid()),
      reasoning: z.string(),
    })),
  }),
});

const ResolveConflictAction = BaseAction.extend({
  type: z.literal('resolve_conflict'),
  payload: z.object({
    entityId: z.string().uuid(),
    fieldName: z.string(),
    resolvedValue: z.unknown(),
    sourcePreferred: z.string(),
    allValues: z.array(z.object({
      source: z.string(),
      value: z.unknown(),
    })),
  }),
});

const InferValueAction = BaseAction.extend({
  type: z.literal('infer_value'),
  payload: z.object({
    entityId: z.string().uuid(),
    fieldName: z.string(),
    inferredValue: z.unknown(),
    inferredFrom: z.string(),
  }),
});

const CorrectValueAction = BaseAction.extend({
  type: z.literal('correct_value'),
  payload: z.object({
    entityId: z.string().uuid(),
    fieldName: z.string(),
    currentValue: z.unknown(),
    correctedValue: z.unknown(),
    correctionType: z.enum(['typo_fix', 'unit_correction', 'format_fix', 'logical_fix']),
  }),
});

const SetSourceTrustAction = BaseAction.extend({
  type: z.literal('set_source_trust'),
  payload: z.object({
    rankings: z.array(z.object({
      domain: z.string(),
      trustLevel: TrustLevel,
      reasoning: z.string(),
    })),
  }),
});

// --- Reprocessing Actions ---

const ReprocessExtractionAction = BaseAction.extend({
  type: z.literal('reprocess_extraction'),
  payload: z.object({
    extractionIds: z.array(z.string().uuid()),
    reason: z.enum(['schema_evolved', 'normalization_added', 'extraction_error']),
    targetSchemaVersion: z.number(),
  }),
});

// --- Finalization Actions ---

const RecommendTableStructureAction = BaseAction.extend({
  type: z.literal('recommend_table_structure'),
  payload: z.object({
    strategy: z.enum(['single_table', 'multi_table']),
    tables: z.array(z.object({
      name: z.string(),
      description: z.string(),
      fields: z.array(z.string()),
      relationship: z.enum(['primary', 'child']).optional(),
      foreignKey: z.string().optional(),
    })),
  }),
});

const DeriveFieldAction = BaseAction.extend({
  type: z.literal('derive_field'),
  payload: z.object({
    fieldName: z.string(),
    fieldDefinition: FieldDefinition,
    derivedFrom: z.array(z.string()),
    derivationLogic: z.string(),
    examples: z.array(z.object({
      inputs: z.record(z.unknown()),
      output: z.unknown(),
    })),
  }),
});

const FlagAnomalyAction = BaseAction.extend({
  type: z.literal('flag_anomaly'),
  payload: z.object({
    entityId: z.string().uuid().optional(),
    fieldName: z.string().optional(),
    anomalyType: z.enum([
      'outlier_value', 'likely_typo', 'contradictory_data',
      'suspicious_duplicate', 'missing_critical',
    ]),
    description: z.string(),
    suggestedFix: z.unknown().optional(),
  }),
});

const GenerateDocumentationAction = BaseAction.extend({
  type: z.literal('generate_documentation'),
  payload: z.object({
    dataDictionary: z.array(z.object({
      fieldName: z.string(),
      description: z.string(),
      valueRange: z.string().optional(),
      exampleValues: z.array(z.unknown()),
      coveragePercent: z.number(),
      sources: z.array(z.string()),
    })),
    categoryBreakdown: z.array(z.object({
      category: z.string(),
      count: z.number(),
      specificFields: z.array(z.string()),
    })),
    qualitySummary: z.object({
      totalEntities: z.number(),
      totalSources: z.number(),
      averageFieldCompleteness: z.number(),
      anomaliesFound: z.number(),
      anomaliesResolved: z.number(),
    }),
  }),
});

// --- Union ---

export const PipelineAction = z.discriminatedUnion('type', [
  AddFieldAction,
  MergeFieldsAction,
  ModifyFieldAction,
  RemoveFieldAction,
  RenameFieldAction,
  SplitFieldAction,
  GroupFieldsAction,
  SetNormalizationRuleAction,
  UpdateEnumMapAction,
  DefineCategoryAction,
  AssignCategoryFieldsAction,
  ClassifyPageAction,
  EnqueueLinksAction,
  HintEntityMatchAction,
  MatchEntitiesAction,
  SplitEntitiesAction,
  ResolveConflictAction,
  InferValueAction,
  CorrectValueAction,
  SetSourceTrustAction,
  ReprocessExtractionAction,
  RecommendTableStructureAction,
  DeriveFieldAction,
  FlagAnomalyAction,
  GenerateDocumentationAction,
]);

export type PipelineAction = z.infer<typeof PipelineAction>;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/actions.ts packages/core/tests/
git commit -m "feat(core): add all 25 PipelineAction types with discriminated union"
```

---

## Task 12: Core Types — Config Actions

**Files:**
- Create: `packages/core/src/types/config-actions.ts`
- Create: `packages/core/tests/unit/types/config-actions.test.ts`

**Step 1: Write the failing test**

`packages/core/tests/unit/types/config-actions.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { ConfigAction } from '../../../src/types/config-actions.js';

describe('ConfigAction', () => {
  const base = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    reasoning: 'User requested this change',
  };

  it('parses set_job_name', () => {
    const result = ConfigAction.parse({
      ...base, type: 'set_job_name',
      payload: { name: 'Audiophile Crawl' },
    });
    expect(result.type).toBe('set_job_name');
  });

  it('parses add_seed_urls', () => {
    const result = ConfigAction.parse({
      ...base, type: 'add_seed_urls',
      payload: {
        urls: [
          { url: 'https://head-fi.org', label: 'Head-Fi' },
          { url: 'https://audiosciencereview.com' },
        ],
      },
    });
    expect(result.payload.urls).toHaveLength(2);
  });

  it('parses set_crawl_depth', () => {
    const result = ConfigAction.parse({
      ...base, type: 'set_crawl_depth',
      payload: { maxDepth: 3 },
    });
    expect(result.payload.maxDepth).toBe(3);
  });

  it('parses add_user_field', () => {
    const result = ConfigAction.parse({
      ...base, type: 'add_user_field',
      payload: {
        field: { name: 'brand', description: 'Product brand', type: 'string', required: true },
      },
    });
    expect(result.payload.field.name).toBe('brand');
  });

  it('parses modify_user_field', () => {
    const result = ConfigAction.parse({
      ...base, type: 'modify_user_field',
      payload: {
        fieldName: 'price',
        changes: { required: true, type: 'currency' },
      },
    });
    expect(result.payload.changes.required).toBe(true);
  });

  it('parses set_schema_mode', () => {
    const result = ConfigAction.parse({
      ...base, type: 'set_schema_mode',
      payload: { mode: 'hybrid' },
    });
    expect(result.payload.mode).toBe('hybrid');
  });

  it('parses set_primary_model', () => {
    const result = ConfigAction.parse({
      ...base, type: 'set_primary_model',
      payload: { model: 'anthropic/claude-sonnet-4-20250514' },
    });
    expect(result.payload.model).toContain('claude');
  });

  it('parses set_model_override', () => {
    const result = ConfigAction.parse({
      ...base, type: 'set_model_override',
      payload: { task: 'pageRelevance', model: 'anthropic/claude-haiku-4-5-20251001' },
    });
    expect(result.payload.task).toBe('pageRelevance');
  });

  it('parses set_action_approval_policy', () => {
    const result = ConfigAction.parse({
      ...base, type: 'set_action_approval_policy',
      payload: { preset: 'trust_ai' },
    });
    expect(result.payload.preset).toBe('trust_ai');
  });

  it('parses save_as_template', () => {
    const result = ConfigAction.parse({
      ...base, type: 'save_as_template',
      payload: { templateName: 'audiophile-default', description: 'Default audiophile config' },
    });
    expect(result.payload.templateName).toBe('audiophile-default');
  });

  it('parses confirm_and_start', () => {
    const result = ConfigAction.parse({
      ...base, type: 'confirm_and_start',
      payload: {},
    });
    expect(result.type).toBe('confirm_and_start');
  });

  it('parses reset_config', () => {
    const result = ConfigAction.parse({
      ...base, type: 'reset_config',
      payload: { keepFields: ['name', 'seedUrls'] },
    });
    expect(result.payload.keepFields).toContain('name');
  });

  it('rejects unknown action type', () => {
    expect(() =>
      ConfigAction.parse({ ...base, type: 'nonexistent', payload: {} })
    ).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write implementation**

`packages/core/src/types/config-actions.ts`:
```typescript
import { z } from 'zod';
import { FieldDefinition } from './schema.js';
import { EvolutionConfig } from './job.js';

const BaseConfigAction = z.object({
  id: z.string().uuid(),
  reasoning: z.string(),
});

// --- Metadata ---

const SetJobNameAction = BaseConfigAction.extend({
  type: z.literal('set_job_name'),
  payload: z.object({ name: z.string() }),
});

const SetJobDescriptionAction = BaseConfigAction.extend({
  type: z.literal('set_job_description'),
  payload: z.object({ description: z.string() }),
});

// --- Seed URLs ---

const AddSeedUrlsAction = BaseConfigAction.extend({
  type: z.literal('add_seed_urls'),
  payload: z.object({
    urls: z.array(z.object({
      url: z.string().url(),
      label: z.string().optional(),
    })),
  }),
});

const RemoveSeedUrlsAction = BaseConfigAction.extend({
  type: z.literal('remove_seed_urls'),
  payload: z.object({
    urls: z.array(z.string().url()),
    reason: z.string().optional(),
  }),
});

const ReplaceSeedUrlsAction = BaseConfigAction.extend({
  type: z.literal('replace_seed_urls'),
  payload: z.object({
    urls: z.array(z.object({
      url: z.string().url(),
      label: z.string().optional(),
    })),
  }),
});

// --- Crawl Settings ---

const SetCrawlDepthAction = BaseConfigAction.extend({
  type: z.literal('set_crawl_depth'),
  payload: z.object({ maxDepth: z.number().min(0).max(10) }),
});

const SetMaxPagesAction = BaseConfigAction.extend({
  type: z.literal('set_max_pages'),
  payload: z.object({ maxPages: z.number().min(1) }),
});

const SetConcurrencyAction = BaseConfigAction.extend({
  type: z.literal('set_concurrency'),
  payload: z.object({ concurrency: z.number().min(1).max(50) }),
});

const SetCrawlerTypeAction = BaseConfigAction.extend({
  type: z.literal('set_crawler_type'),
  payload: z.object({
    crawlerType: z.enum(['playwright', 'firecrawl']),
    reason: z.string().optional(),
  }),
});

// --- Schema Fields ---

const AddUserFieldAction = BaseConfigAction.extend({
  type: z.literal('add_user_field'),
  payload: z.object({
    field: FieldDefinition,
    position: z.enum(['first', 'last', 'after']).default('last'),
    afterField: z.string().optional(),
  }),
});

const AddMultipleUserFieldsAction = BaseConfigAction.extend({
  type: z.literal('add_multiple_user_fields'),
  payload: z.object({
    fields: z.array(FieldDefinition),
  }),
});

const RemoveUserFieldAction = BaseConfigAction.extend({
  type: z.literal('remove_user_field'),
  payload: z.object({ fieldName: z.string() }),
});

const ModifyUserFieldAction = BaseConfigAction.extend({
  type: z.literal('modify_user_field'),
  payload: z.object({
    fieldName: z.string(),
    changes: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      type: z.enum(['string', 'number', 'boolean', 'url', 'currency', 'enum', 'array', 'object']).optional(),
      required: z.boolean().optional(),
      enumValues: z.array(z.string()).optional(),
      arrayItemType: FieldDefinition.optional(),
      objectFields: z.array(FieldDefinition).optional(),
    }),
  }),
});

const ReorderUserFieldsAction = BaseConfigAction.extend({
  type: z.literal('reorder_user_fields'),
  payload: z.object({
    fieldOrder: z.array(z.string()),
  }),
});

const ReplaceAllUserFieldsAction = BaseConfigAction.extend({
  type: z.literal('replace_all_user_fields'),
  payload: z.object({
    fields: z.array(FieldDefinition),
  }),
});

const DefineNestedFieldAction = BaseConfigAction.extend({
  type: z.literal('define_nested_field'),
  payload: z.object({
    parentFieldName: z.string(),
    subFields: z.array(FieldDefinition),
  }),
});

// --- Schema Mode ---

const SetSchemaModeAction = BaseConfigAction.extend({
  type: z.literal('set_schema_mode'),
  payload: z.object({
    mode: z.enum(['fixed', 'discovery', 'hybrid']),
  }),
});

const SetEvolutionConfigAction = BaseConfigAction.extend({
  type: z.literal('set_evolution_config'),
  payload: z.object({
    enabled: z.boolean().optional(),
    batchSize: z.number().optional(),
    maxFields: z.number().optional(),
    relevanceThresholds: z.object({
      requiredMin: z.number().optional(),
      optionalMin: z.number().optional(),
      rareBelow: z.number().optional(),
      minCategorySampleSize: z.number().optional(),
    }).optional(),
    tableStrategy: z.enum(['single', 'multi', 'auto']).optional(),
  }),
});

// --- LLM Config ---

const LLMTask = z.enum([
  'pageRelevance', 'extraction', 'linkEvaluation',
  'schemaEvolution', 'entityMatching', 'conflictResolution',
  'qualityAudit', 'documentation',
]);

const SetPrimaryModelAction = BaseConfigAction.extend({
  type: z.literal('set_primary_model'),
  payload: z.object({ model: z.string() }),
});

const SetModelOverrideAction = BaseConfigAction.extend({
  type: z.literal('set_model_override'),
  payload: z.object({ task: LLMTask, model: z.string() }),
});

const ClearModelOverrideAction = BaseConfigAction.extend({
  type: z.literal('clear_model_override'),
  payload: z.object({ task: LLMTask }),
});

// --- Reconciliation Config ---

const SetMatchStrategyAction = BaseConfigAction.extend({
  type: z.literal('set_match_strategy'),
  payload: z.object({
    matchStrategy: z.enum(['exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted']),
    fuzzyMatchThreshold: z.number().optional(),
    enableLLMMatching: z.boolean().optional(),
  }),
});

const SetConflictResolutionAction = BaseConfigAction.extend({
  type: z.literal('set_conflict_resolution'),
  payload: z.object({
    strategy: z.enum(['most_common', 'most_complete', 'source_priority', 'most_recent', 'llm_resolved']),
  }),
});

const SetSourcePriorityAction = BaseConfigAction.extend({
  type: z.literal('set_source_priority'),
  payload: z.object({
    rankings: z.array(z.object({
      domain: z.string(),
      trustLevel: z.enum(['authoritative', 'high', 'medium', 'low']),
      reasoning: z.string().optional(),
    })),
  }),
});

// --- Safety ---

const SetActionApprovalPolicyAction = BaseConfigAction.extend({
  type: z.literal('set_action_approval_policy'),
  payload: z.object({
    preset: z.enum(['trust_ai', 'balanced', 'cautious', 'manual']).optional(),
    overrides: z.array(z.object({
      actionType: z.string(),
      policy: z.enum(['always_auto', 'auto_above_threshold', 'always_review', 'batch_review']),
      threshold: z.number().optional(),
    })).optional(),
  }),
});

// --- Templates ---

const SaveAsTemplateAction = BaseConfigAction.extend({
  type: z.literal('save_as_template'),
  payload: z.object({
    templateName: z.string(),
    description: z.string().optional(),
  }),
});

const LoadTemplateAction = BaseConfigAction.extend({
  type: z.literal('load_template'),
  payload: z.object({
    templateName: z.string(),
    overrides: z.record(z.unknown()).optional(),
  }),
});

const CloneJobConfigAction = BaseConfigAction.extend({
  type: z.literal('clone_job_config'),
  payload: z.object({
    sourceJobId: z.string().uuid(),
    overrides: z.record(z.unknown()).optional(),
  }),
});

// --- Control ---

const ConfirmAndStartAction = BaseConfigAction.extend({
  type: z.literal('confirm_and_start'),
  payload: z.object({}),
});

const ResetConfigAction = BaseConfigAction.extend({
  type: z.literal('reset_config'),
  payload: z.object({
    keepFields: z.array(z.enum([
      'name', 'description', 'seedUrls', 'userFields',
      'crawlSettings', 'llmConfig',
    ])).optional(),
  }),
});

// --- Union ---

export const ConfigAction = z.discriminatedUnion('type', [
  SetJobNameAction,
  SetJobDescriptionAction,
  AddSeedUrlsAction,
  RemoveSeedUrlsAction,
  ReplaceSeedUrlsAction,
  SetCrawlDepthAction,
  SetMaxPagesAction,
  SetConcurrencyAction,
  SetCrawlerTypeAction,
  AddUserFieldAction,
  AddMultipleUserFieldsAction,
  RemoveUserFieldAction,
  ModifyUserFieldAction,
  ReorderUserFieldsAction,
  ReplaceAllUserFieldsAction,
  DefineNestedFieldAction,
  SetSchemaModeAction,
  SetEvolutionConfigAction,
  SetPrimaryModelAction,
  SetModelOverrideAction,
  ClearModelOverrideAction,
  SetMatchStrategyAction,
  SetConflictResolutionAction,
  SetSourcePriorityAction,
  SetActionApprovalPolicyAction,
  SaveAsTemplateAction,
  LoadTemplateAction,
  CloneJobConfigAction,
  ConfirmAndStartAction,
  ResetConfigAction,
]);

export type ConfigAction = z.infer<typeof ConfigAction>;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types/config-actions.ts packages/core/tests/
git commit -m "feat(core): add all 30 ConfigAction types with discriminated union"
```

---

## Task 13: Core Types — Barrel Exports

**Files:**
- Create: `packages/core/src/types/index.ts`

**Step 1: Create the barrel export**

`packages/core/src/types/index.ts`:
```typescript
export * from './normalization.js';
export * from './schema.js';
export * from './job.js';
export * from './extraction.js';
export * from './reconciliation.js';
export * from './actions.js';
export * from './config-actions.js';
```

**Step 2: Create interfaces barrel (empty for now)**

`packages/core/src/interfaces/index.ts`:
```typescript
export * from './crawler.js';
export * from './extractor.js';
export * from './schema-evolver.js';
export * from './content-store.js';
export * from './orchestrator.js';
export * from './reconciler.js';
export * from './exporter.js';
export * from './action-executor.js';
export * from './config-executor.js';
```

**Step 3: Build core package**

Run: `cd packages/core && pnpm build`
Expected: Fails because interfaces don't exist yet — that's Task 14

**Step 4: Commit**

```bash
git add packages/core/src/types/index.ts
git commit -m "feat(core): add types barrel export"
```

---

## Task 14: Core Interfaces

**Files:**
- Create: `packages/core/src/interfaces/crawler.ts`
- Create: `packages/core/src/interfaces/extractor.ts`
- Create: `packages/core/src/interfaces/schema-evolver.ts`
- Create: `packages/core/src/interfaces/content-store.ts`
- Create: `packages/core/src/interfaces/orchestrator.ts`
- Create: `packages/core/src/interfaces/reconciler.ts`
- Create: `packages/core/src/interfaces/exporter.ts`
- Create: `packages/core/src/interfaces/action-executor.ts`
- Create: `packages/core/src/interfaces/config-executor.ts`
- Create: `packages/core/src/interfaces/index.ts`
- Create: `packages/core/tests/unit/interfaces/interfaces.test.ts`

**Step 1: Write a structural test**

`packages/core/tests/unit/interfaces/interfaces.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as interfaces from '../../../src/interfaces/index.js';

describe('core interfaces are exported', () => {
  const expectedExports = [
    'CrawlResult',
    'CrawlOptions',
    'ExportOptions',
    'ExportResult',
    'ExportFormat',
    'ActionResult',
    'ActionPreview',
    'StateChange',
    'ConfigValidationResult',
    'ConfigDiff',
  ];

  for (const name of expectedExports) {
    it(`exports ${name}`, () => {
      expect((interfaces as Record<string, unknown>)[name]).toBeDefined();
    });
  }
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL

**Step 3: Write all interface files**

`packages/core/src/interfaces/crawler.ts`:
```typescript
import { z } from 'zod';

export const CrawlOptions = z.object({
  timeout: z.number().default(30000),
  waitForSelector: z.string().optional(),
  headers: z.record(z.string()).optional(),
  userAgent: z.string().optional(),
});

export type CrawlOptions = z.infer<typeof CrawlOptions>;

export const CrawlResult = z.object({
  url: z.string().url(),
  html: z.string(),
  title: z.string().optional(),
  statusCode: z.number(),
  contentType: z.string().optional(),
  links: z.array(z.object({
    url: z.string(),
    text: z.string().optional(),
    rel: z.string().optional(),
  })),
  metadata: z.object({
    crawledAt: z.coerce.date(),
    responseTimeMs: z.number(),
    contentLength: z.number(),
    crawlerType: z.enum(['playwright', 'firecrawl']),
  }),
});

export type CrawlResult = z.infer<typeof CrawlResult>;

export interface Crawler {
  readonly type: 'playwright' | 'firecrawl';
  crawl(url: string, options?: CrawlOptions): Promise<CrawlResult>;
  close(): Promise<void>;
}
```

`packages/core/src/interfaces/extractor.ts`:
```typescript
import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';

export interface Extractor {
  extract(
    html: string,
    url: string,
    schema: SchemaDefinition,
    jobDescription: string,
  ): Promise<ExtractionResult>;
}
```

`packages/core/src/interfaces/schema-evolver.ts`:
```typescript
import type { SchemaDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import type { PipelineAction } from '../types/actions.js';

export interface SchemaEvolver {
  evolve(
    currentSchema: SchemaDefinition,
    recentExtractions: ExtractionResult[],
    jobDescription: string,
  ): Promise<PipelineAction[]>;
}
```

`packages/core/src/interfaces/content-store.ts`:
```typescript
export interface ContentStore {
  store(key: string, content: string): Promise<string>;
  retrieve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}
```

`packages/core/src/interfaces/orchestrator.ts`:
```typescript
import type { JobConfig, JobStatus } from '../types/job.js';

export interface JobOrchestrator {
  createJob(config: JobConfig): Promise<string>;
  startJob(jobId: string): Promise<void>;
  pauseJob(jobId: string): Promise<void>;
  resumeJob(jobId: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  getJobStatus(jobId: string): Promise<JobStatus>;
}
```

`packages/core/src/interfaces/reconciler.ts`:
```typescript
import type { ExtractionResult } from '../types/extraction.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { EntityMatch } from '../types/reconciliation.js';
import type { ReconciliationConfig } from '../types/job.js';
import type { PipelineAction } from '../types/actions.js';

export interface DataReconciler {
  reconcile(
    extractions: ExtractionResult[],
    schema: SchemaDefinition,
    config: ReconciliationConfig,
  ): Promise<{
    entities: EntityMatch[];
    actions: PipelineAction[];
  }>;
}
```

`packages/core/src/interfaces/exporter.ts`:
```typescript
import { z } from 'zod';
import type { SchemaDefinition } from '../types/schema.js';

export const ExportFormat = z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite']);
export type ExportFormat = z.infer<typeof ExportFormat>;

export const ExportOptions = z.object({
  format: ExportFormat,
  includeProvenance: z.boolean().default(false),
  includeDocumentation: z.boolean().default(true),
  outputPath: z.string().optional(),
});

export type ExportOptions = z.infer<typeof ExportOptions>;

export const ExportResult = z.object({
  format: ExportFormat,
  entityCount: z.number(),
  filePath: z.string().optional(),
  data: z.unknown().optional(),
  generatedAt: z.coerce.date(),
});

export type ExportResult = z.infer<typeof ExportResult>;

export interface Exporter {
  readonly format: ExportFormat;
  export(
    entities: unknown[],
    schema: SchemaDefinition,
    options: ExportOptions,
  ): Promise<ExportResult>;
}
```

`packages/core/src/interfaces/action-executor.ts`:
```typescript
import { z } from 'zod';
import type { PipelineAction } from '../types/actions.js';

export const StateChange = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

export type StateChange = z.infer<typeof StateChange>;

export const ActionResult = z.object({
  actionId: z.string().uuid(),
  status: z.enum(['applied', 'rejected', 'deferred']),
  stateChanges: z.array(StateChange),
  rejectionReason: z.string().optional(),
});

export type ActionResult = z.infer<typeof ActionResult>;

export const ActionPreview = z.object({
  actionId: z.string().uuid(),
  wouldChange: z.array(StateChange),
  riskLevel: z.enum(['low', 'medium', 'high']),
  requiresApproval: z.boolean(),
});

export type ActionPreview = z.infer<typeof ActionPreview>;

export interface ActionExecutor {
  execute(action: PipelineAction): Promise<ActionResult>;
  rollback(actionId: string): Promise<void>;
  preview(action: PipelineAction): Promise<ActionPreview>;
}
```

`packages/core/src/interfaces/config-executor.ts`:
```typescript
import { z } from 'zod';
import type { JobConfig } from '../types/job.js';
import type { ConfigAction } from '../types/config-actions.js';

export const ConfigValidationResult = z.object({
  valid: z.boolean(),
  missing: z.array(z.string()),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export type ConfigValidationResult = z.infer<typeof ConfigValidationResult>;

export const ConfigDiff = z.object({
  changes: z.array(z.object({
    path: z.string(),
    before: z.unknown(),
    after: z.unknown(),
    description: z.string(),
  })),
});

export type ConfigDiff = z.infer<typeof ConfigDiff>;

export interface ConfigExecutor {
  apply(config: JobConfig, action: ConfigAction): JobConfig;
  applyBatch(config: JobConfig, actions: ConfigAction[]): JobConfig;
  validate(config: JobConfig): ConfigValidationResult;
  diff(before: JobConfig, after: JobConfig): ConfigDiff;
}
```

`packages/core/src/interfaces/index.ts`:
```typescript
export * from './crawler.js';
export * from './extractor.js';
export * from './schema-evolver.js';
export * from './content-store.js';
export * from './orchestrator.js';
export * from './reconciler.js';
export * from './exporter.js';
export * from './action-executor.js';
export * from './config-executor.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: PASS

**Step 5: Build the full core package**

Run: `cd packages/core && pnpm build`
Expected: Compiles with no errors

**Step 6: Commit**

```bash
git add packages/core/src/interfaces/ packages/core/tests/
git commit -m "feat(core): add all core interfaces (Crawler, Extractor, SchemaEvolver, etc.)"
```

---

## Task 15: ESLint & Prettier Configuration

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc`
- Create: `.prettierignore`

**Step 1: Create ESLint config (flat config format)**

`eslint.config.js`:
```javascript
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'warn',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'],
  },
];
```

**Step 2: Create Prettier config**

`.prettierrc`:
```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

`.prettierignore`:
```
dist
node_modules
.turbo
pnpm-lock.yaml
```

**Step 3: Run lint**

Run: `pnpm lint`
Expected: Passes (may have warnings for `z.any()` usage, which is intentional)

**Step 4: Run format check**

Run: `pnpm format:check`
Expected: Some files may need formatting

**Step 5: Format all files**

Run: `pnpm format`

**Step 6: Commit**

```bash
git add eslint.config.js .prettierrc .prettierignore
git add -u  # any reformatted files
git commit -m "feat: add ESLint + Prettier configuration"
```

---

## Task 16: Final Verification & Build

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass across shared and core packages

**Step 2: Run full build**

Run: `pnpm build`
Expected: All packages compile (db, queue, api, cli may have warnings but should not error)

**Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

**Step 4: Run lint**

Run: `pnpm lint`
Expected: Clean or only intentional warnings

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "chore: Phase 1 final verification — all tests pass, builds clean"
```

---

## Summary

Phase 1 delivers:
- **Monorepo scaffold** with 4 packages + 2 apps, Turborepo pipeline, TypeScript config
- **Shared package** with logger, error hierarchy, config helpers, utility functions
- **Core types** — 7 NormalizationRule types, FieldDefinition with recursive nesting, category-aware FieldRelevance, SchemaDefinition, JobConfig, ExtractionResult, EntityMatch, 25 PipelineAction types, 30 ConfigAction types
- **Core interfaces** — Crawler, Extractor, SchemaEvolver, ContentStore, JobOrchestrator, DataReconciler, Exporter, ActionExecutor, ConfigExecutor
- **Dev tooling** — ESLint, Prettier, Vitest across all packages
- **~16 commits** with focused, atomic changes

Total action types implemented: **55** (25 pipeline + 30 config)
Total Zod schemas: **~80+** (types, sub-types, enums, interfaces with Zod validators)
Total test files: **8** covering all type validation
