import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectLock } from '../../../src/pipeline/project-lock.js';

describe('ProjectLock', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spatula-lock-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('acquires lock when no existing lock', () => {
    const lock = new ProjectLock(tempDir);
    expect(lock.acquire()).toBe(true);
    expect(existsSync(join(tempDir, 'run.lock'))).toBe(true);
    lock.release();
  });

  it('releases lock and removes file', () => {
    const lock = new ProjectLock(tempDir);
    lock.acquire();
    lock.release();
    expect(existsSync(join(tempDir, 'run.lock'))).toBe(false);
  });

  it('detects stale lock and acquires', () => {
    writeFileSync(join(tempDir, 'run.lock'), '999999');
    const lock = new ProjectLock(tempDir);
    expect(lock.acquire()).toBe(true);
    lock.release();
  });
});
