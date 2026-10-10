import { prepareTestDatabase } from '@spatula/store/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** Rebuilds the Workers tests' database. The config hands its URL to the Hyperdrive binding. */
export default async function setup(project: TestProject) {
  project.provide('databaseUrl', await prepareTestDatabase('spatula_workers_test'));
}
