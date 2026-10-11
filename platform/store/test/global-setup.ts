import type { TestProject } from 'vitest/node';
import { prepareTestDatabase } from '../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** The store's tests get their own database, rebuilt from the migrations on every run. */
export default async function setup(project: TestProject) {
  project.provide('databaseUrl', await prepareTestDatabase('spatula_store_test'));
}
