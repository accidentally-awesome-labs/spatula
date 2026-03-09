import { createDatabase, type Database } from '../../src/connection.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/spatula_test';

export function createTestDatabase(): Database {
  return createDatabase(TEST_DB_URL);
}
