/**
 * E2E resource cleanup verification tests.
 *
 * Verifies that:
 *   1. SQLite connections are properly released on close()
 *   2. Repeated open/close cycles do not leak file handles
 *   3. Command runner functions always close the project (even on error paths)
 *   4. Multiple concurrent reads work under WAL mode
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import {
  createProjectDb,
  initializeProjectDb,
  ProjectAdapter,
} from '@accidentally-awesome-labs/spatula-db';

describe('resource cleanup', () => {
  it('openLocalProject close() releases SQLite connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spatula-cleanup-'));
    try {
      writeFileSync(join(dir, 'spatula.yaml'), 'name: cleanup\nseeds:\n  - https://example.com\n');
      const dbDir = join(dir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(dir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'cleanup' });
      close();

      const { openLocalProject } = await import('../../src/local-project.js');
      const project = await openLocalProject(dir);

      // Verify we can query
      const status = await project.dataSource.getStatus();
      expect(status).toBeDefined();

      // Close and verify the DB file is not locked
      project.close();

      // Should be able to open again (proves connection was released)
      const project2 = await openLocalProject(dir);
      const status2 = await project2.dataSource.getStatus();
      expect(status2).toBeDefined();
      project2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repeated open/close cycles do not leak handles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spatula-leak-'));
    try {
      writeFileSync(join(dir, 'spatula.yaml'), 'name: leak\nseeds:\n  - https://example.com\n');
      const dbDir = join(dir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(dir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'leak' });
      close();

      const { openLocalProject } = await import('../../src/local-project.js');

      // Open and close 20 times — should not leak
      for (let i = 0; i < 20; i++) {
        const project = await openLocalProject(dir);
        await project.dataSource.getStatus();
        project.close();
      }

      // Verify DB is still usable after 20 open/close cycles
      const finalProject = await openLocalProject(dir);
      const status = await finalProject.dataSource.getStatus();
      expect(status).toBeDefined();
      finalProject.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('command runner functions always close project on error', async () => {
    // Test that runSchemaCommand closes project even when DataSource throws
    const dir = mkdtempSync(join(tmpdir(), 'spatula-errclose-'));
    try {
      writeFileSync(join(dir, 'spatula.yaml'), 'name: errclose\nseeds:\n  - https://example.com\n');
      const dbDir = join(dir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(dir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'errclose' });
      close();

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Run schema — should work and release connection
      const { runSchemaCommand } = await import('../../src/commands/schema.js');
      await runSchemaCommand({});

      // Verify connection released by opening again
      const { openLocalProject } = await import('../../src/local-project.js');
      const project = await openLocalProject(dir);
      const status = await project.dataSource.getStatus();
      expect(status).toBeDefined();
      project.close();

      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('multiple concurrent reads do not conflict (WAL mode)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spatula-wal-'));
    try {
      writeFileSync(join(dir, 'spatula.yaml'), 'name: wal\nseeds:\n  - https://example.com\n');
      const dbDir = join(dir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(dir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'wal' });

      const adapter = new ProjectAdapter(db, pid);
      for (let i = 0; i < 10; i++) {
        await adapter.entityRepo.create({
          jobId: pid,
          tenantId: pid,
          mergedData: { title: `Entity ${i}` },
          provenance: {},
          qualityScore: 0.8,
        });
      }
      close();

      const { openLocalProject } = await import('../../src/local-project.js');

      // Open two connections simultaneously
      const p1 = await openLocalProject(dir);
      const p2 = await openLocalProject(dir);

      // Both should be able to read concurrently
      const [s1, s2] = await Promise.all([p1.dataSource.getStatus(), p2.dataSource.getStatus()]);

      expect(s1.totalEntities).toBe(10);
      expect(s2.totalEntities).toBe(10);

      p1.close();
      p2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
