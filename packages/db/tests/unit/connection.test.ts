import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.doMock (not vi.mock) so mocks survive vi.resetModules()
// Each test re-imports modules dynamically to test env var handling

describe('createDatabasePool', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT;

    // Re-apply mocks after module reset
    vi.doMock('pg', () => {
      const mockPool = {
        on: vi.fn().mockReturnThis(),
        end: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };
      return { Pool: vi.fn(() => mockPool) };
    });
    vi.doMock('drizzle-orm/node-postgres', () => ({
      drizzle: vi.fn(() => ({ query: {} })),
    }));
    vi.doMock('../../src/schema/index.js', () => ({}));
  });

  it('creates pool with connection string from parameter', async () => {
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    const result = createDatabasePool('postgresql://test:test@localhost:5432/test');

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://test:test@localhost:5432/test',
      }),
    );
    expect(result).toHaveProperty('db');
    expect(result).toHaveProperty('pool');
  });

  it('falls back to DATABASE_URL env var', async () => {
    process.env.DATABASE_URL = 'postgresql://env:env@localhost:5432/envdb';
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    createDatabasePool();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://env:env@localhost:5432/envdb',
      }),
    );
  });

  it('throws StorageError when no connection string provided', async () => {
    const { createDatabasePool } = await import('../../src/connection.js');

    expect(() => createDatabasePool()).toThrow('DATABASE_URL is required');
  });

  it('uses default pool settings', async () => {
    process.env.DATABASE_URL = 'postgresql://test@localhost/db';
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    createDatabasePool();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }),
    );
  });

  it('reads pool settings from env vars', async () => {
    process.env.DATABASE_URL = 'postgresql://test@localhost/db';
    process.env.DB_POOL_MAX = '5';
    process.env.DB_POOL_IDLE_TIMEOUT = '10000';
    const { createDatabasePool } = await import('../../src/connection.js');
    const { Pool } = await import('pg');

    createDatabasePool();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 5,
        idleTimeoutMillis: 10000,
      }),
    );
  });
});

describe('createDatabase (backward compat)', () => {
  it('still works for callers that only need db', async () => {
    process.env.DATABASE_URL = 'postgresql://test@localhost/db';
    const { createDatabase } = await import('../../src/connection.js');

    const db = createDatabase();
    expect(db).toBeDefined();
  });
});
