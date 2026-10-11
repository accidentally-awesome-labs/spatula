import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareTestDatabase } from './testing';

describe('prepareTestDatabase', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    'spatula_store',
    'Spatula_test',
    '_test',
    'spatula_test"; drop database spatula; --_test',
  ])('refuses %j before connecting to anything', async (name) => {
    // Nothing listens on port 1 of this machine, so a connection would fail with ECONNREFUSED,
    // not with the refusal.
    vi.stubEnv('SPATULA_DATABASE_URL', 'postgres://spatula:spatula@localhost:1/spatula');
    await expect(prepareTestDatabase(name)).rejects.toThrow(
      `${JSON.stringify(name)} isn’t a test database’s name: use lowercase letters, digits, and underscores, ending in _test.`,
    );
  });
});
