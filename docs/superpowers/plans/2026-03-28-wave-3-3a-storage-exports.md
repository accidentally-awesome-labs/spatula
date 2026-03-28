# Wave 3-3a: Performance — Storage & Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add S3-compatible object storage for content and streaming export pipeline to reduce memory pressure and support large datasets.

**Architecture:** A pluggable `S3ContentStore` implements the existing `ContentStore` interface using `@aws-sdk/client-s3`, selected by a factory based on `CONTENT_STORE` env var. An optional `getDownloadUrl()` method enables presigned URL redirects for export downloads. New `StreamingJsonExporter` and `StreamingCsvExporter` accept `AsyncIterable<Entity[]>` (cursor-based batches) and produce output progressively. The export orchestrator is adapted to use cursor-based entity fetching instead of loading everything into memory. Binary formats (Parquet, SQLite, DuckDB) continue to materialize but with chunked fetching.

**Tech Stack:** TypeScript, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, Drizzle ORM, Hono, Vitest

**Spec references:**
- Phase 12 spec: sections 6.1-6.2
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`
- Decomposition: `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md` section 4.4

**Depends on:** Existing `ContentStore` interface in `packages/core/src/interfaces/content-store.ts` (Wave 1). This sub-plan is an independent root per the decomposition design — no dependency on Wave 3-1a/3-1b.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/core/src/content-store/s3-content-store.ts` | `S3ContentStore` implementing `ContentStore` + `getDownloadUrl()` |
| `packages/core/src/content-store/factory.ts` | `createContentStore()` factory |
| `packages/core/src/content-store/index.ts` | Barrel export |
| `packages/core/src/exporters/streaming-json-exporter.ts` | Streaming JSON exporter for `AsyncIterable<Entity[]>` |
| `packages/core/src/exporters/streaming-csv-exporter.ts` | Streaming CSV exporter for `AsyncIterable<Entity[]>` |
| `packages/core/src/pipeline/entity-cursor.ts` | `fetchEntitiesCursor()` async generator |
| `packages/core/tests/unit/content-store/s3-content-store.test.ts` | S3 content store tests |
| `packages/core/tests/unit/content-store/factory.test.ts` | Factory tests |
| `packages/core/tests/unit/exporters/streaming-json-exporter.test.ts` | Streaming JSON tests |
| `packages/core/tests/unit/exporters/streaming-csv-exporter.test.ts` | Streaming CSV tests |
| `packages/core/tests/unit/pipeline/entity-cursor.test.ts` | Entity cursor tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/core/src/interfaces/content-store.ts` | Add optional `getDownloadUrl()` method |
| `packages/core/src/index.ts` | Export new content store, streaming exporters, entity cursor |
| `packages/db/src/repositories/entity-repository.ts` | Add `findByJobCursor()` method |
| `packages/core/src/pipeline/types.ts` | Add `findByJobCursor` to `EntityRepo` interface |
| `packages/core/src/pipeline/export-orchestrator.ts` | Use cursor-based fetching, branch on format |
| `apps/api/src/routes/exports.ts` | Presigned URL redirect for S3 downloads |

---

## Task 1: ContentStore Interface Extension

**Files:**
- Modify: `packages/core/src/interfaces/content-store.ts`

- [ ] **Step 1: Add optional getDownloadUrl method**

Read the current file. Add the optional method:

```typescript
export interface ContentStore {
  store(key: string, content: string): Promise<string>;
  retrieve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
  storeBinary(key: string, data: Uint8Array): Promise<string>;
  retrieveBinary(ref: string): Promise<Uint8Array | null>;
  getDownloadUrl?(ref: string, expiresInSeconds?: number): Promise<string>;
}
```

- [ ] **Step 2: Add type guard**

Add below the interface:

```typescript
export function supportsPresignedUrls(
  store: ContentStore,
): store is ContentStore & { getDownloadUrl: (ref: string, expiresIn?: number) => Promise<string> } {
  return typeof (store as any).getDownloadUrl === 'function';
}
```

- [ ] **Step 3: Build**

```bash
pnpm --filter @spatula/core build && pnpm --filter @spatula/db build
```

Both must build cleanly since `PgContentStore` implements `ContentStore` and the new method is optional.

- [ ] **Step 4: Run existing tests**

```bash
pnpm --filter @spatula/core test && pnpm --filter @spatula/db test
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/interfaces/content-store.ts
git commit -m "feat(core): add optional getDownloadUrl to ContentStore interface"
```

---

## Task 2: S3ContentStore Implementation

**Files:**
- Create: `packages/core/src/content-store/s3-content-store.ts`
- Create: `packages/core/tests/unit/content-store/s3-content-store.test.ts`

- [ ] **Step 1: Install AWS SDK**

```bash
pnpm --filter @spatula/core add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

- [ ] **Step 2: Write failing tests**

```typescript
// packages/core/tests/unit/content-store/s3-content-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AWS SDK before importing
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://bucket.s3.amazonaws.com/signed-url'),
}));

import { S3ContentStore } from '../../../src/content-store/s3-content-store.js';
import { S3Client } from '@aws-sdk/client-s3';

describe('S3ContentStore', () => {
  let store: S3ContentStore;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new S3ContentStore({
      bucket: 'test-bucket',
      region: 'us-east-1',
    });
    // Access the mock send function
    mockSend = (S3Client as any).mock.results[0].value.send;
  });

  describe('store', () => {
    it('uploads text content with text/ prefix and returns s3:// ref', async () => {
      mockSend.mockResolvedValue({});
      const ref = await store.store('my-key', 'hello world');
      expect(ref).toBe('s3://test-bucket/text/my-key');
    });
  });

  describe('storeBinary', () => {
    it('uploads binary content with binary/ prefix', async () => {
      mockSend.mockResolvedValue({});
      const data = new Uint8Array([1, 2, 3]);
      const ref = await store.storeBinary('my-key', data);
      expect(ref).toBe('s3://test-bucket/binary/my-key');
    });
  });

  describe('retrieve', () => {
    it('downloads and returns text content', async () => {
      mockSend.mockResolvedValue({
        Body: { transformToString: vi.fn().mockResolvedValue('hello world') },
      });
      const content = await store.retrieve('s3://test-bucket/text/my-key');
      expect(content).toBe('hello world');
    });
  });

  describe('retrieveBinary', () => {
    it('downloads and returns binary content', async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      mockSend.mockResolvedValue({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(bytes) },
      });
      const result = await store.retrieveBinary('s3://test-bucket/binary/my-key');
      expect(result).toEqual(bytes);
    });

    it('returns null when object not found', async () => {
      const err = new Error('NoSuchKey');
      (err as any).name = 'NoSuchKey';
      mockSend.mockRejectedValue(err);
      const result = await store.retrieveBinary('s3://test-bucket/binary/missing');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes the object', async () => {
      mockSend.mockResolvedValue({});
      await expect(store.delete('s3://test-bucket/text/my-key')).resolves.not.toThrow();
    });
  });

  describe('getDownloadUrl', () => {
    it('returns a presigned URL', async () => {
      const url = await store.getDownloadUrl('s3://test-bucket/text/my-key', 3600);
      expect(url).toContain('signed-url');
    });
  });

  describe('error handling', () => {
    it('store throws StorageError on S3 failure', async () => {
      mockSend.mockRejectedValue(new Error('AccessDenied'));
      await expect(store.store('key', 'content')).rejects.toThrow('Failed to store content in S3');
    });

    it('retrieve throws StorageError on S3 failure', async () => {
      mockSend.mockRejectedValue(new Error('InternalError'));
      await expect(store.retrieve('s3://test-bucket/text/key')).rejects.toThrow('Failed to retrieve from S3');
    });

    it('parseRef throws on invalid ref format', async () => {
      await expect(store.retrieve('pg://wrong-format')).rejects.toThrow('Invalid S3 ref format');
    });
  });
});
```

- [ ] **Step 3: Implement S3ContentStore**

```typescript
// packages/core/src/content-store/s3-content-store.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ContentStore } from '../interfaces/content-store.js';
import { StorageError } from '@spatula/shared';
import { createLogger } from '@spatula/shared';

const logger = createLogger('s3-content-store');

export interface S3ContentStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3ContentStore implements ContentStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private tenantId?: string;
  private tenantRepo?: { incrementStorageBytes(tenantId: string, bytes: number): Promise<void> };

  /**
   * Set tenant context for storage byte tracking.
   * Same pattern as PgContentStore.setTenantContext().
   * Per decomposition spec: "3-3a wires the same tracking into S3ContentStore."
   */
  setTenantContext(tenantId: string, tenantRepo: { incrementStorageBytes(tenantId: string, bytes: number): Promise<void> }): void {
    this.tenantId = tenantId;
    this.tenantRepo = tenantRepo;
  }

  constructor(config: S3ContentStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
        : {}),
    });
  }

  async store(key: string, content: string): Promise<string> {
    const s3Key = `text/${key}`;
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: content,
        ContentType: 'text/plain; charset=utf-8',
      }));
      const ref = `s3://${this.bucket}/${s3Key}`;
      logger.debug({ ref, key }, 'text content stored');

      // Track storage bytes (fire-and-forget, same pattern as PgContentStore)
      if (this.tenantId && this.tenantRepo) {
        const bytes = Buffer.byteLength(content, 'utf-8');
        void this.tenantRepo.incrementStorageBytes(this.tenantId, bytes)
          .catch((err: unknown) => logger.warn({ err }, 'Failed to track storage bytes'));
      }

      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store content in S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key, bucket: this.bucket },
      });
    }
  }

  async storeBinary(key: string, data: Uint8Array): Promise<string> {
    const s3Key = `binary/${key}`;
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: data,
        ContentType: 'application/octet-stream',
      }));
      const ref = `s3://${this.bucket}/${s3Key}`;
      logger.debug({ ref, key, size: data.byteLength }, 'binary content stored');

      // Track storage bytes (fire-and-forget)
      if (this.tenantId && this.tenantRepo) {
        void this.tenantRepo.incrementStorageBytes(this.tenantId, data.byteLength)
          .catch((err: unknown) => logger.warn({ err }, 'Failed to track storage bytes'));
      }

      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store binary in S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key, bucket: this.bucket },
      });
    }
  }

  async retrieve(ref: string): Promise<string> {
    const { bucket, key } = this.parseRef(ref);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await response.Body!.transformToString();
    } catch (error) {
      throw new StorageError(`Failed to retrieve from S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async retrieveBinary(ref: string): Promise<Uint8Array | null> {
    const { bucket, key } = this.parseRef(ref);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await response.Body!.transformToByteArray();
    } catch (error) {
      if ((error as any).name === 'NoSuchKey') return null;
      throw new StorageError(`Failed to retrieve binary from S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async delete(ref: string): Promise<void> {
    const { bucket, key } = this.parseRef(ref);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      logger.debug({ ref }, 'content deleted from S3');
    } catch (error) {
      throw new StorageError(`Failed to delete from S3: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async getDownloadUrl(ref: string, expiresInSeconds = 3600): Promise<string> {
    const { bucket, key } = this.parseRef(ref);
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (error) {
      throw new StorageError(`Failed to generate presigned URL: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  private parseRef(ref: string): { bucket: string; key: string } {
    if (!ref.startsWith('s3://')) {
      throw new StorageError(`Invalid S3 ref format: ${ref}`, { context: { ref } });
    }
    const withoutProtocol = ref.slice(5); // Remove "s3://"
    const slashIndex = withoutProtocol.indexOf('/');
    if (slashIndex === -1) {
      throw new StorageError(`Invalid S3 ref format: ${ref}`, { context: { ref } });
    }
    return {
      bucket: withoutProtocol.slice(0, slashIndex),
      key: withoutProtocol.slice(slashIndex + 1),
    };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @spatula/core test -- --run s3-content-store
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/content-store/ packages/core/tests/unit/content-store/s3-content-store.test.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): add S3ContentStore with presigned URL support"
```

---

## Task 3: Content Store Factory

**Files:**
- Create: `packages/core/src/content-store/factory.ts`
- Create: `packages/core/src/content-store/index.ts`
- Create: `packages/core/tests/unit/content-store/factory.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/content-store/factory.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

import { createContentStore } from '../../../src/content-store/factory.js';
import { S3ContentStore } from '../../../src/content-store/s3-content-store.js';

describe('createContentStore', () => {
  it('returns S3ContentStore when type is "s3"', () => {
    const store = createContentStore({
      type: 's3',
      s3: { bucket: 'test', region: 'us-east-1' },
    });
    expect(store).toBeInstanceOf(S3ContentStore);
  });

  it('throws for "postgres" type (PgContentStore is in @spatula/db, not @spatula/core)', () => {
    expect(() => createContentStore({ type: 'postgres' })).toThrow(
      'PgContentStore must be created via @spatula/db',
    );
  });

  it('throws for unknown type', () => {
    expect(() => createContentStore({ type: 'unknown' as any })).toThrow(
      'Unknown content store type: unknown',
    );
  });
});
```

- [ ] **Step 2: Implement factory**

```typescript
// packages/core/src/content-store/factory.ts
import { ConfigError } from '@spatula/shared';
import type { ContentStore } from '../interfaces/content-store.js';
import { S3ContentStore } from './s3-content-store.js';
import type { S3ContentStoreConfig } from './s3-content-store.js';

export interface ContentStoreConfig {
  type: 'postgres' | 's3';
  s3?: S3ContentStoreConfig;
}

export function createContentStore(config: ContentStoreConfig): ContentStore {
  switch (config.type) {
    case 's3':
      if (!config.s3) {
        throw new ConfigError('S3 configuration required when CONTENT_STORE=s3');
      }
      return new S3ContentStore(config.s3);
    case 'postgres':
      // PgContentStore lives in @spatula/db and depends on the Drizzle database.
      // It must be created directly by the deployer, not through this factory.
      throw new ConfigError('PgContentStore must be created via @spatula/db');
    default:
      throw new ConfigError(`Unknown content store type: ${config.type}`);
  }
}
```

- [ ] **Step 3: Create barrel export**

```typescript
// packages/core/src/content-store/index.ts
export { S3ContentStore } from './s3-content-store.js';
export type { S3ContentStoreConfig } from './s3-content-store.js';
export { createContentStore } from './factory.js';
export type { ContentStoreConfig } from './factory.js';
```

- [ ] **Step 4: Export from core barrel**

Add to `packages/core/src/index.ts`:
```typescript
export * from './content-store/index.js';
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @spatula/core test -- --run content-store/factory
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/content-store/ packages/core/tests/unit/content-store/factory.test.ts packages/core/src/index.ts
git commit -m "feat(core): add content store factory with S3 selection"
```

---

## Task 4: Entity Cursor

**Files:**
- Modify: `packages/db/src/repositories/entity-repository.ts`
- Modify: `packages/core/src/pipeline/types.ts`
- Create: `packages/core/src/pipeline/entity-cursor.ts`
- Create: `packages/core/tests/unit/pipeline/entity-cursor.test.ts`

- [ ] **Step 1: Add findByJobCursor to EntityRepository**

Read `packages/db/src/repositories/entity-repository.ts`. Add this method:

```typescript
  async findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ entities: Array<typeof entities.$inferSelect>; nextCursor: string | null }> {
    try {
      const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];
      if (cursor) {
        conditions.push(sql`${entities.id} > ${cursor}`);
      }

      const rows = await this.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(entities.id)
        .limit(limit);

      const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
      return { entities: rows, nextCursor };
    } catch (error) {
      throw new StorageError(`Failed to fetch entities by cursor: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId, cursor },
      });
    }
  }
```

Add the `sql` import if not already present.

**Note on ordering:** This method orders by `entities.id` (insertion order), while the existing `findByJob` orders by `quality_score DESC`. This is intentional — keyset pagination requires a unique, ordered column. `id` is the natural choice. Streaming exports produce entities in insertion order, not quality score order. This is documented as an acceptable behavioral change.

- [ ] **Step 2: Add findByJobCursor to EntityRepo interface in pipeline types**

Read `packages/core/src/pipeline/types.ts`. Add to `EntityRepo`:

```typescript
  findByJobCursor?(jobId: string, tenantId: string, limit: number, cursor?: string): Promise<{ entities: unknown[]; nextCursor: string | null }>;
```

- [ ] **Step 3: Write failing entity cursor tests**

```typescript
// packages/core/tests/unit/pipeline/entity-cursor.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchEntitiesCursor } from '../../../src/pipeline/entity-cursor.js';

describe('fetchEntitiesCursor', () => {
  it('yields entity batches until no more results', async () => {
    const mockRepo = {
      findByJobCursor: vi.fn()
        .mockResolvedValueOnce({ entities: [{ id: '1' }, { id: '2' }], nextCursor: '2' })
        .mockResolvedValueOnce({ entities: [{ id: '3' }], nextCursor: null }),
    };

    const batches: unknown[][] = [];
    for await (const batch of fetchEntitiesCursor(mockRepo as any, 'job-1', 'tenant-1', 2)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
    expect(mockRepo.findByJobCursor).toHaveBeenCalledTimes(2);
  });

  it('yields nothing when no entities exist', async () => {
    const mockRepo = {
      findByJobCursor: vi.fn().mockResolvedValue({ entities: [], nextCursor: null }),
    };

    const batches: unknown[][] = [];
    for await (const batch of fetchEntitiesCursor(mockRepo as any, 'job-1', 'tenant-1', 500)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Implement fetchEntitiesCursor**

```typescript
// packages/core/src/pipeline/entity-cursor.ts

export interface CursorEntityRepo {
  findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ entities: unknown[]; nextCursor: string | null }>;
}

export async function* fetchEntitiesCursor(
  entityRepo: CursorEntityRepo,
  jobId: string,
  tenantId: string,
  batchSize = 500,
): AsyncIterable<unknown[]> {
  let cursor: string | undefined;
  while (true) {
    const batch = await entityRepo.findByJobCursor(jobId, tenantId, batchSize, cursor);
    if (batch.entities.length === 0) break;
    yield batch.entities;
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
}
```

- [ ] **Step 5: Export from pipeline barrel and core index**

Add to appropriate barrel exports. Check if `packages/core/src/pipeline/index.ts` exists; if so, add:
```typescript
export { fetchEntitiesCursor } from './entity-cursor.js';
export type { CursorEntityRepo } from './entity-cursor.js';
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @spatula/core test -- --run entity-cursor
pnpm --filter @spatula/db test
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/entity-repository.ts packages/core/src/pipeline/entity-cursor.ts packages/core/src/pipeline/types.ts packages/core/tests/unit/pipeline/entity-cursor.test.ts packages/core/src/pipeline/index.ts
git commit -m "feat: add entity cursor with keyset pagination for streaming exports"
```

---

## Task 5: Streaming JSON Exporter

**Files:**
- Create: `packages/core/src/exporters/streaming-json-exporter.ts`
- Create: `packages/core/tests/unit/exporters/streaming-json-exporter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/exporters/streaming-json-exporter.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingJsonExporter } from '../../../src/exporters/streaming-json-exporter.js';

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c)).join('');
}

async function* makeEntityBatches(batches: unknown[][]): AsyncIterable<unknown[]> {
  for (const batch of batches) {
    yield batch;
  }
}

describe('StreamingJsonExporter', () => {
  const exporter = new StreamingJsonExporter();

  it('produces valid JSON array from multiple batches', async () => {
    const batches = [
      [{ id: '1', mergedData: { name: 'A' } }, { id: '2', mergedData: { name: 'B' } }],
      [{ id: '3', mergedData: { name: 'C' } }],
    ];

    const stream = exporter.export(makeEntityBatches(batches));
    const result = await collectStream(stream);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].mergedData.name).toBe('A');
    expect(parsed[2].mergedData.name).toBe('C');
  });

  it('produces empty array for no batches', async () => {
    const stream = exporter.export(makeEntityBatches([]));
    const result = await collectStream(stream);
    expect(JSON.parse(result)).toEqual([]);
  });

  it('produces valid JSON for single entity', async () => {
    const batches = [[{ id: '1', mergedData: { name: 'Solo' } }]];
    const stream = exporter.export(makeEntityBatches(batches));
    const result = await collectStream(stream);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement StreamingJsonExporter**

```typescript
// packages/core/src/exporters/streaming-json-exporter.ts

const encoder = new TextEncoder();

export class StreamingJsonExporter {
  export(entityBatches: AsyncIterable<unknown[]>): ReadableStream<Uint8Array> {
    let isFirst = true;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('['));

        for await (const batch of entityBatches) {
          for (const entity of batch) {
            if (!isFirst) {
              controller.enqueue(encoder.encode(','));
            }
            controller.enqueue(encoder.encode(JSON.stringify(entity)));
            isFirst = false;
          }
        }

        controller.enqueue(encoder.encode(']'));
        controller.close();
      },
    });
  }
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @spatula/core test -- --run streaming-json
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/exporters/streaming-json-exporter.ts packages/core/tests/unit/exporters/streaming-json-exporter.test.ts packages/core/src/exporters/index.ts
git commit -m "feat(core): add StreamingJsonExporter for cursor-based entity batches"
```

**Note:** Also add to `packages/core/src/exporters/index.ts`:
```typescript
export { StreamingJsonExporter } from './streaming-json-exporter.js';
```
```

---

## Task 6: Streaming CSV Exporter

**Files:**
- Create: `packages/core/src/exporters/streaming-csv-exporter.ts`
- Create: `packages/core/tests/unit/exporters/streaming-csv-exporter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/exporters/streaming-csv-exporter.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingCsvExporter } from '../../../src/exporters/streaming-csv-exporter.js';

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks.map((c) => new TextDecoder().decode(c)).join('');
}

async function* makeEntityBatches(batches: unknown[][]): AsyncIterable<unknown[]> {
  for (const batch of batches) yield batch;
}

describe('StreamingCsvExporter', () => {
  const exporter = new StreamingCsvExporter();

  it('produces CSV with header from first batch and data rows', async () => {
    const batches = [
      [{ mergedData: { name: 'Alice', age: 30 } }, { mergedData: { name: 'Bob', age: 25 } }],
      [{ mergedData: { name: 'Charlie', age: 35 } }],
    ];

    const stream = exporter.export(makeEntityBatches(batches));
    const result = await collectStream(stream);
    const lines = result.trim().split('\n');

    expect(lines[0]).toBe('name,age');
    expect(lines).toHaveLength(4); // header + 3 data rows
    expect(lines[1]).toContain('Alice');
  });

  it('produces empty output for no batches', async () => {
    const stream = exporter.export(makeEntityBatches([]));
    const result = await collectStream(stream);
    expect(result).toBe('');
  });
});
```

- [ ] **Step 2: Implement StreamingCsvExporter**

```typescript
// packages/core/src/exporters/streaming-csv-exporter.ts

const encoder = new TextEncoder();

function escapeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class StreamingCsvExporter {
  /**
   * @param columns Optional column list for consistent ordering.
   *                If not provided, columns are derived from the first entity's mergedData keys.
   *                Pass schema field names for deterministic output.
   */
  export(entityBatches: AsyncIterable<unknown[]>, columns?: string[]): ReadableStream<Uint8Array> {
    let headerWritten = false;
    let resolvedColumns: string[] = columns ?? [];

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const batch of entityBatches) {
          for (const entity of batch) {
            const data = (entity as any).mergedData ?? entity;

            if (!headerWritten) {
              if (resolvedColumns.length === 0) {
                resolvedColumns = Object.keys(data);
              }
              controller.enqueue(encoder.encode(resolvedColumns.join(',') + '\n'));
              headerWritten = true;
            }

            const row = resolvedColumns.map((col) => escapeCsvValue(data[col]));
            controller.enqueue(encoder.encode(row.join(',') + '\n'));
          }
        }
        controller.close();
      },
    });
  }
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @spatula/core test -- --run streaming-csv
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/exporters/streaming-csv-exporter.ts packages/core/tests/unit/exporters/streaming-csv-exporter.test.ts packages/core/src/exporters/index.ts
git commit -m "feat(core): add StreamingCsvExporter for cursor-based entity batches"
```

**Note:** Also add to `packages/core/src/exporters/index.ts`:
```typescript
export { StreamingCsvExporter } from './streaming-csv-exporter.js';
```
```

---

## Task 7: Export Orchestrator Adaptation

**Files:**
- Modify: `packages/core/src/pipeline/export-orchestrator.ts`

- [ ] **Step 1: Read the current export orchestrator**

Read `packages/core/src/pipeline/export-orchestrator.ts` thoroughly. The current flow:
1. Fetches ALL entities via offset pagination into `allEntities[]` array
2. Runs exporter on the full array
3. Stores result

The new flow for JSON/CSV:
1. Use `fetchEntitiesCursor()` to stream entities
2. Use `StreamingJsonExporter` or `StreamingCsvExporter` to produce output stream
3. Collect stream output into a string for storage

For binary formats (Parquet, SQLite, DuckDB):
1. Use `fetchEntitiesCursor()` to collect all entities (still reduces memory by fetching in chunks)
2. Run existing exporter on the full array

- [ ] **Step 2: Update the orchestrator**

Add imports:
```typescript
import { StreamingJsonExporter } from '../exporters/streaming-json-exporter.js';
import { StreamingCsvExporter } from '../exporters/streaming-csv-exporter.js';
import { fetchEntitiesCursor } from './entity-cursor.js';
```

In the `processExport` function, replace the entity fetching and export logic (steps 3-5). The key change is that for JSON/CSV, we use the streaming pipeline. For binary formats, we still collect all entities but via cursor instead of offset.

Read the file first to understand exact structure, then make the minimal changes needed. The entity fetching loop should change from offset-based to cursor-based regardless of format. The exporter dispatch should branch:

```typescript
    // 3. Fetch entities via cursor
    const streamingFormats = new Set(['json', 'csv']);

    if (streamingFormats.has(format) && deps.entityRepo.findByJobCursor) {
      // Streaming export for JSON/CSV
      const entityStream = fetchEntitiesCursor(deps.entityRepo as any, jobId, tenantId, 500);
      const streamExporter = format === 'json'
        ? new StreamingJsonExporter()
        : new StreamingCsvExporter();
      const outputStream = streamExporter.export(entityStream);

      // Collect stream to string
      const reader = outputStream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const content = new TextDecoder().decode(Buffer.concat(chunks));
      // ... store content, update export status
    } else {
      // Binary formats or fallback: collect all entities via cursor, then run exporter
      // ... existing logic but with cursor-based fetching
    }
```

**Critical design notes for the streaming path:**

1. **JSON envelope:** The current JSON export wraps entities in an envelope: `{ metadata, schema, documentation, entities }`. The `StreamingJsonExporter` produces a flat JSON array. For the streaming path, collect the stream output into a string, parse it as the entities array, then construct the envelope around it (same as current logic). This preserves the output structure.

2. **Provenance:** The current orchestrator uses `findByJobWithProvenance` when `includeProvenance && format === 'json'`. The cursor-based `findByJobCursor` does NOT have a provenance variant. When provenance is requested, **fall back to the non-streaming offset-based path**. The conditional should be: `if (streamingFormats.has(format) && !useProvenance && deps.entityRepo.findByJobCursor)`.

3. **Entity count:** Track entity count during streaming by counting in a closure variable, or count after collecting the stream. The count is needed for `exportRepo.updateStatus()`.

4. **Ordering change:** The cursor path orders by `entities.id` (insertion order), while the old offset path orders by `quality_score DESC`. This is an intentional change for streaming mode — keyset pagination requires a unique, ordered column. Document this: "Streaming exports produce entities in insertion order (by ID), not quality score order."

5. **Binary formats:** For Parquet/SQLite/DuckDB, use cursor-based fetching to collect all entities into an array (reducing peak memory via chunked fetching), then pass to the existing exporter. This means binary formats also benefit from cursor fetching even though they materialize.

- [ ] **Step 3: Add tests for the streaming code path**

Add 2-3 new tests to `packages/core/tests/unit/pipeline/export-orchestrator.test.ts`:

- Test that when `entityRepo.findByJobCursor` is available and format is `csv`, the streaming path is used (verify `findByJobCursor` is called instead of `findByJob`)
- Test that when format is `json` with `includeProvenance`, the old offset path is used (verify `findByJobWithProvenance` is called)
- Test that binary formats still use the old path even when `findByJobCursor` is available

- [ ] **Step 4: Run all export orchestrator tests**

```bash
pnpm --filter @spatula/core test -- --run export-orchestrator
```

All existing tests must pass. The cursor-based path is conditional on `findByJobCursor` being available.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/pipeline/export-orchestrator.ts
git commit -m "feat(core): adapt export orchestrator to use cursor-based entity fetching and streaming exporters"
```

---

## Task 8: Export Download Presigned URL Redirect

**Files:**
- Modify: `apps/api/src/routes/exports.ts`

- [ ] **Step 1: Read the current download handler**

Read `apps/api/src/routes/exports.ts`, specifically the `downloadExportRoute` handler.

- [ ] **Step 2: Add presigned URL redirect**

Add the import at the top:
```typescript
import { supportsPresignedUrls } from '@spatula/core';
```

First, update the `downloadExportRoute` OpenAPI definition to include a 302 response. Find the `responses` object and add:

```typescript
  302: { description: 'Redirect to presigned download URL' },
```

Then in the download handler, before the existing content retrieval logic, add a presigned URL check:

```typescript
    // If content store supports presigned URLs, redirect instead of streaming
    if (supportsPresignedUrls(deps.contentStore)) {
      const url = await deps.contentStore.getDownloadUrl(exportRecord.contentRef, 3600);
      return c.redirect(url, 302);
    }

    // Otherwise, stream through the API (existing logic)
```

This goes after the `exportRecord` validation and before the `CONTENT_TYPES` lookup.

- [ ] **Step 3: Run all API tests**

```bash
pnpm --filter @spatula/api test
```

Existing tests use `PgContentStore` (no `getDownloadUrl`), so `supportsPresignedUrls` returns false and the existing stream-through path is used. No test breakage.

- [ ] **Step 4: Add test for presigned URL redirect path**

In `apps/api/tests/unit/routes/exports.test.ts`, read the existing tests then add a test that provides a content store mock WITH `getDownloadUrl`:

```typescript
  it('redirects to presigned URL when content store supports it', async () => {
    // Create mock with getDownloadUrl
    const mockContentStore = {
      retrieve: vi.fn(),
      retrieveBinary: vi.fn(),
      getDownloadUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed-url'),
      store: vi.fn(),
      storeBinary: vi.fn(),
      delete: vi.fn(),
    };

    // Create test app with the S3-like content store
    // ... (follow the existing test pattern but replace contentStore in deps)

    const res = await app.request(`/api/v1/jobs/${jobId}/export/${exportId}/download`);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('signed-url');
  });
```

Read the existing export test file to understand the mock structure and adapt accordingly.

- [ ] **Step 5: Add env var reading for content store configuration**

Create a helper in `apps/api/src/app.ts` or a dedicated config file that reads the `CONTENT_STORE` env var and constructs the appropriate content store. This enables deployers to switch to S3 via env vars without code changes.

In `apps/api/src/app.ts`, add a helper (or note that the wiring happens in the server bootstrap where `AppDeps` is assembled — typically outside `createApp()`). The most practical approach: document how to wire it in the server entry point:

```typescript
// Example wiring for server entry point (not in createApp — deps are assembled by deployer):
//
// import { createContentStore } from '@spatula/core';
// import { PgContentStore } from '@spatula/db';
// import { getEnvOrDefault } from '@spatula/shared';
//
// const contentStoreType = getEnvOrDefault('CONTENT_STORE', 'postgres');
// const contentStore = contentStoreType === 's3'
//   ? createContentStore({
//       type: 's3',
//       s3: {
//         bucket: getEnvOrDefault('S3_BUCKET', ''),
//         region: getEnvOrDefault('S3_REGION', 'us-east-1'),
//         endpoint: process.env.S3_ENDPOINT,
//         accessKeyId: process.env.S3_ACCESS_KEY_ID,
//         secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
//       },
//     })
//   : new PgContentStore(db);
```

Add this as a comment block in `packages/core/src/content-store/factory.ts` so the wiring pattern is documented alongside the factory.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/exports.ts
git commit -m "feat(api): add presigned URL redirect for S3-backed export downloads"
```

---

## Task 9: Integration Verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm --filter @spatula/api test && pnpm --filter @spatula/db test && pnpm --filter @spatula/shared test && pnpm --filter @spatula/queue test && pnpm --filter @spatula/core test
```

Expected: 1,500+ existing tests all pass, plus ~15 new tests.

- [ ] **Step 2: Verify key functionality**

- S3ContentStore tests (6+ tests)
- Factory tests (3 tests)
- Entity cursor tests (2 tests)
- StreamingJsonExporter tests (3 tests)
- StreamingCsvExporter tests (2 tests)
- Export orchestrator tests (all existing pass)
- Export download endpoint (existing tests pass, presigned URL is conditional)

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration issues in storage and exports"
```
