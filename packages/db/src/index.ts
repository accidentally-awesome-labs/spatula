// Schema
export * from './schema/index.js';

// Connection
export { createDatabase, createDatabasePool } from './connection.js';
export type { Database, DatabasePool } from './connection.js';

// Repositories
export { JobRepository } from './repositories/job-repository.js';
export type { CreateJobInput } from './repositories/job-repository.js';
export { CrawlTaskRepository } from './repositories/crawl-task-repository.js';
export type { EnqueueTaskInput } from './repositories/crawl-task-repository.js';
export { SchemaRepository } from './repositories/schema-repository.js';
export type { CreateSchemaInput } from './repositories/schema-repository.js';
export { ExtractionRepository } from './repositories/extraction-repository.js';
export type { StoreExtractionInput } from './repositories/extraction-repository.js';
export { PageRepository } from './repositories/page-repository.js';
export type { CreatePageInput } from './repositories/page-repository.js';
export { EntityRepository } from './repositories/entity-repository.js';
export type { CreateEntityInput } from './repositories/entity-repository.js';
export { SourceTrustRepository } from './repositories/source-trust-repository.js';
export type { UpsertSourceTrustInput } from './repositories/source-trust-repository.js';
export { EntitySourceRepository } from './repositories/entity-source-repository.js';
export { ActionRepository } from './repositories/action-repository.js';
export type { ActionStatus, FindActionsOptions, CreateActionInput } from './repositories/action-repository.js';
export { ExportRepository } from './repositories/export-repository.js';
export type { CreateExportInput } from './repositories/export-repository.js';
export { TenantRepository } from './repositories/tenant-repository.js';
export type { CreateTenantInput, UpdateTenantInput } from './repositories/tenant-repository.js';
export { DlqRepository } from './repositories/dlq-repository.js';
export type { DlqInsertInput } from './repositories/dlq-repository.js';
export { ApiKeyRepository } from './repositories/api-key-repository.js';
export type { CreateApiKeyInput } from './repositories/api-key-repository.js';
export { AuditLogRepository } from './repositories/audit-log-repository.js';
export type { AuditLogEntry } from './repositories/audit-log-repository.js';
export { LlmUsageRepository } from './repositories/llm-usage-repository.js';
export type { LlmUsageInput, UsageAggregation } from './repositories/llm-usage-repository.js';

// Content Store
export { PgContentStore } from './content-store/pg-content-store.js';

// Migrations
export { runMigrations } from './migrate.js';

// Project database (SQLite for local mode)
export { createProjectDb, initializeProjectDb } from './project-db/connection.js';
export type { ProjectDatabase, ProjectDbResult } from './project-db/connection.js';
export * as sqliteSchema from './schema-sqlite/index.js';

// Project-db repositories and adapter
export { ProjectAdapter } from './project-db/adapter.js';
export { SqliteJobRepository } from './project-db/repositories/job-repository.js';
export { SqlitePageRepository } from './project-db/repositories/page-repository.js';
export type { CreatePageInput as SqliteCreatePageInput } from './project-db/repositories/page-repository.js';
export { SqliteExtractionRepository } from './project-db/repositories/extraction-repository.js';
export { SqliteEntityRepository, SqliteEntitySourceRepository } from './project-db/repositories/entity-repository.js';
export { SqliteSchemaRepository } from './project-db/repositories/schema-repository.js';
export { SqliteCrawlTaskRepository } from './project-db/repositories/crawl-task-repository.js';
export { SqliteActionRepository } from './project-db/repositories/action-repository.js';
export { SqliteSourceTrustRepository } from './project-db/repositories/source-trust-repository.js';
export { RunRepository } from './project-db/repositories/run-repository.js';
export { LlmUsageRepository as SqliteLlmUsageRepository } from './project-db/repositories/llm-usage-repository.js';
export { SqliteExportRepository } from './project-db/repositories/export-repository.js';
export { ProjectMetaRepository } from './project-db/repositories/project-meta-repository.js';
