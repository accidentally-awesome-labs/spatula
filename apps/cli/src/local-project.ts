import { join } from 'node:path';
import { findProjectRoot } from '@accidentally-awesome-labs/spatula-core';
import type { DataSource } from '@accidentally-awesome-labs/spatula-core';
import type { ProjectAdapter as ProjectAdapterType } from '@accidentally-awesome-labs/spatula-db';

export interface LocalProject {
  dataSource: DataSource;
  projectRoot: string;
  projectId: string;
  metaRepo: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    deleteByPrefix(prefix: string): Promise<void>;
  };
  adapter: ProjectAdapterType;
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
  const { createProjectDb, ProjectAdapter } = await import('@accidentally-awesome-labs/spatula-db');
  const { LocalDataSource } = await import('@accidentally-awesome-labs/spatula-core');

  const projectId = slugifyPath(projectRoot);

  let dbResult;
  try {
    dbResult = createProjectDb(dbPath);
  } catch (err) {
    throw new Error(`Failed to open project database at ${dbPath}: ${(err as Error).message}`);
  }

  const adapter = new ProjectAdapter(dbResult.db, projectId);
  const dataSource = new LocalDataSource(adapter);

  return {
    dataSource,
    projectRoot,
    projectId,
    metaRepo: adapter.metaRepo,
    adapter,
    close: () => dbResult.close(),
  };
}
