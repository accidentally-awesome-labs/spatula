import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { slugifyPath } from '../../src/local-project.js';

describe('slugifyPath', () => {
  it('takes last two path segments', () => {
    expect(slugifyPath('/home/user/projects/my-crawl')).toBe('projects-my-crawl');
  });

  it('lowercases and strips non-alphanumeric', () => {
    expect(slugifyPath('/Users/Me/My Project!')).toBe('me-my-project-');
  });

  it('normalises Windows backslashes', () => {
    expect(slugifyPath('C:\\Users\\me\\data\\crawl-test')).toBe('data-crawl-test');
  });

  it('handles single segment', () => {
    expect(slugifyPath('/crawl')).toBe('crawl');
  });
});

import { openLocalProject } from '../../src/local-project.js';

describe('openLocalProject', () => {
  it('throws when no spatula.yaml found', async () => {
    await expect(openLocalProject('/tmp/nonexistent-project-dir')).rejects.toThrow(
      'No spatula.yaml found',
    );
  });
});

describe('openLocalProject — success path', () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Create a temp project directory with spatula.yaml
    tmpDir = join(tmpdir(), `spatula-local-project-test-${Date.now()}`);
    mkdirSync(join(tmpDir, '.spatula'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'spatula.yaml'),
      'name: test-project\nseeds:\n  - https://example.com\n',
      'utf-8',
    );

    // Initialize the SQLite database so tables exist when openLocalProject opens it
    const { createProjectDb, initializeProjectDb } =
      await import('@accidentally-awesome-labs/spatula-db');
    const dbPath = join(tmpDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    initializeProjectDb(db, { projectId: slugifyPath(tmpDir), name: 'test-project' });
    close();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a LocalProject with all required fields', async () => {
    const project = await openLocalProject(tmpDir);
    try {
      expect(project.projectRoot).toBe(tmpDir);
      expect(project.projectId).toBe(slugifyPath(tmpDir));
      expect(project.dataSource).toBeDefined();
      expect(project.metaRepo).toBeDefined();
      expect(typeof project.close).toBe('function');
    } finally {
      project.close();
    }
  });

  it('metaRepo.get and set work correctly', async () => {
    const project = await openLocalProject(tmpDir);
    try {
      // Initially empty
      const val = await project.metaRepo.get('test-key');
      expect(val).toBeNull();

      // Set and read back
      await project.metaRepo.set('test-key', 'test-value');
      const val2 = await project.metaRepo.get('test-key');
      expect(val2).toBe('test-value');
    } finally {
      project.close();
    }
  });

  it('metaRepo.deleteByPrefix removes matching keys', async () => {
    const project = await openLocalProject(tmpDir);
    try {
      await project.metaRepo.set('remote:prod:job_id', 'job-1');
      await project.metaRepo.set('remote:prod:pushed_at', '2026-01-01');
      await project.metaRepo.set('other:key', 'keep');

      await project.metaRepo.deleteByPrefix('remote:prod:');

      expect(await project.metaRepo.get('remote:prod:job_id')).toBeNull();
      expect(await project.metaRepo.get('remote:prod:pushed_at')).toBeNull();
      expect(await project.metaRepo.get('other:key')).toBe('keep');
    } finally {
      project.close();
    }
  });

  it('dataSource.getStatus returns a valid ProjectStatus', async () => {
    const project = await openLocalProject(tmpDir);
    try {
      const status = await project.dataSource.getStatus();
      expect(status).toHaveProperty('totalPages');
      expect(status).toHaveProperty('totalEntities');
      expect(status).toHaveProperty('pendingActions');
    } finally {
      project.close();
    }
  });
});
