import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = { select: vi.fn() };
const mockMigrate = vi.fn().mockResolvedValue(undefined);
const mockCreateDatabase = vi.fn().mockReturnValue(mockDb);

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: mockMigrate,
}));

vi.mock('../../src/connection.js', () => ({
  createDatabase: mockCreateDatabase,
}));

const { runMigrations } = await import('../../src/migrate.js');

describe('runMigrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMigrate.mockResolvedValue(undefined);
  });

  it('calls drizzle migrate with a migrationsFolder ending in /drizzle', async () => {
    await runMigrations('postgresql://localhost:5432/spatula_test');

    expect(mockCreateDatabase).toHaveBeenCalledWith(
      'postgresql://localhost:5432/spatula_test',
    );
    expect(mockMigrate).toHaveBeenCalledOnce();
    expect(mockMigrate).toHaveBeenCalledWith(mockDb, {
      migrationsFolder: expect.stringMatching(/\/drizzle$/),
    });
  });

  it('passes undefined to createDatabase when no connection string provided', async () => {
    await runMigrations();

    expect(mockCreateDatabase).toHaveBeenCalledWith(undefined);
  });

  it('propagates migration errors', async () => {
    const error = new Error('migration failed');
    mockMigrate.mockRejectedValueOnce(error);

    await expect(runMigrations('postgresql://localhost:5432/spatula_test')).rejects.toThrow(
      error,
    );
  });
});
