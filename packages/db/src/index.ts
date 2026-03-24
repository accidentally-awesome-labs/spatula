// Schema
export * from './schema/index.js';

// Connection
export { createDatabase, createDatabasePool } from './connection.js';
export type { Database, DatabasePool } from './connection.js';

// Repositories
export * from './repositories/index.js';

// Content Store
export { PgContentStore } from './content-store/pg-content-store.js';

// Migrations
export { runMigrations } from './migrate.js';

// Project database (SQLite for local mode)
export { createProjectDb, initializeProjectDb } from './project-db/connection.js';
export type { ProjectDatabase, ProjectDbResult } from './project-db/connection.js';
export * as sqliteSchema from './schema-sqlite/index.js';
