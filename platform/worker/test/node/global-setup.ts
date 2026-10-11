import { prepareTestDatabase } from '@spatula/store/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  project.provide('databaseUrl', await prepareTestDatabase('spatula_worker_test'));
}
