import { createDatabase } from '@spatula/store';
import { afterAll, inject } from 'vitest';

// The pipeline tests don't roll back: each one uses its own dataset, so they can't collide.
const database = createDatabase(inject('databaseUrl'), { max: 2 });
afterAll(database.close);

export const db = database.db;
