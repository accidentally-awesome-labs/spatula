import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = { select: vi.fn() };
const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
const mockMigrate = vi.fn().mockResolvedValue(undefined);
const mockCreateDatabasePool = vi.fn().mockReturnValue({
  db: mockDb,
  pool: { end: mockPoolEnd },
});

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: mockMigrate,
}));

vi.mock('../../src/connection.js', () => ({
  createDatabasePool: mockCreateDatabasePool,
}));

const { runMigrations } = await import('../../src/migrate.js');

describe('runMigrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMigrate.mockResolvedValue(undefined);
    mockPoolEnd.mockResolvedValue(undefined);
  });

  it('calls drizzle migrate with a migrationsFolder ending in /drizzle', async () => {
    await runMigrations('postgresql://localhost:5432/spatula_test');

    expect(mockCreateDatabasePool).toHaveBeenCalledWith(
      'postgresql://localhost:5432/spatula_test',
    );
    expect(mockMigrate).toHaveBeenCalledOnce();
    expect(mockMigrate).toHaveBeenCalledWith(mockDb, {
      migrationsFolder: expect.stringMatching(/\/drizzle$/),
    });
  });

  it('passes undefined to createDatabasePool when no connection string provided', async () => {
    await runMigrations();

    expect(mockCreateDatabasePool).toHaveBeenCalledWith(undefined);
  });

  it('propagates migration errors', async () => {
    const error = new Error('migration failed');
    mockMigrate.mockRejectedValueOnce(error);

    await expect(runMigrations('postgresql://localhost:5432/spatula_test')).rejects.toThrow(
      error,
    );
  });

  it('closes the pool on success', async () => {
    await runMigrations('postgresql://localhost:5432/spatula_test');
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });

  it('closes the pool even when migration throws', async () => {
    mockMigrate.mockRejectedValueOnce(new Error('boom'));
    await expect(runMigrations('postgresql://localhost:5432/spatula_test')).rejects.toThrow('boom');
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });
});
