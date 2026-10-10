import { afterAll, inject } from 'vitest';
import { createDatabase } from '../src/client';
import { rollbackRunner } from '../src/testing';

const { db, close } = createDatabase(inject('databaseUrl'), { max: 1 });
afterAll(close);

export const withRollback = rollbackRunner(db);
