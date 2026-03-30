import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalContentStore } from '../../../src/content-store/local-content-store.js';

describe('LocalContentStore', () => {
  let tempDir: string;
  let store: LocalContentStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spatula-test-'));
    store = new LocalContentStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores text content and returns file:// ref', async () => {
    const ref = await store.store('page-1', '<html>Hello</html>');
    expect(ref).toContain('file://');
    const content = await readFile(ref.replace('file://', ''), 'utf-8');
    expect(content).toBe('<html>Hello</html>');
  });

  it('retrieves stored text content', async () => {
    const ref = await store.store('page-2', '<html>World</html>');
    const content = await store.retrieve(ref);
    expect(content).toBe('<html>World</html>');
  });

  it('stores and retrieves binary content', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const ref = await store.storeBinary('export-1', data);
    const retrieved = await store.retrieveBinary(ref);
    expect(retrieved).toEqual(data);
  });

  it('deletes stored content', async () => {
    const ref = await store.store('page-3', 'content');
    await store.delete(ref);
    const retrieved = await store.retrieveBinary(ref);
    expect(retrieved).toBeNull();
  });

  it('returns null for missing binary content', async () => {
    const result = await store.retrieveBinary('file:///nonexistent');
    expect(result).toBeNull();
  });
});
