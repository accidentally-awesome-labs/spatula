import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../src/connection.js';

describe('createDatabase', () => {
  it('creates a drizzle instance from a connection string', () => {
    const db = createDatabase('postgresql://localhost:5432/spatula_test');
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('creates a drizzle instance from default env var', () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://localhost:5432/spatula_test';
    try {
      const db = createDatabase();
      expect(db).toBeDefined();
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      } else {
        delete process.env.DATABASE_URL;
      }
    }
  });

  it('throws StorageError when no URL provided and env missing', () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createDatabase()).toThrow('DATABASE_URL');
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      }
    }
  });
});
