import { join } from 'node:path';
import { findProjectRoot } from '@spatula/core';
import type { DataSource } from '@spatula/core';

export interface LocalProject {
  dataSource: DataSource;
  projectRoot: string;
  projectId: string;
  close(): void;
}

export function slugifyPath(absPath: string): string {
  const parts = absPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts
    .slice(-2)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

export async function openLocalProject(cwd: string): Promise<LocalProject> {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    throw new Error(
      'No spatula.yaml found. Run `spatula init` to create a project, or change to a project directory.',
    );
  }

  const dbPath = join(projectRoot, '.spatula', 'project.db');
  const { createProjectDb, ProjectAdapter } = await import('@spatula/db');
  const { LocalDataSource } = await import('@spatula/core');

  const projectId = slugifyPath(projectRoot);

  let dbResult;
  try {
    dbResult = createProjectDb(dbPath);
  } catch (err) {
    throw new Error(
      `Failed to open project database at ${dbPath}: ${(err as Error).message}`,
    );
  }

  const adapter = new ProjectAdapter(dbResult.db, projectId);
  const dataSource = new LocalDataSource(adapter);

  return {
    dataSource,
    projectRoot,
    projectId,
    close: () => dbResult.close(),
  };
}
