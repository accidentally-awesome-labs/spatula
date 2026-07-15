/**
 * Repository barrel — exports all 12 SQLite repository classes and
 * any relevant types for use via the @accidentally-awesome-labs/spatula-db package.
 */

// Mirrored repos (receive db + projectId — pre-bound synthetic project ID)
export { SqliteJobRepository } from './job-repository.js';
export { SqlitePageRepository } from './page-repository.js';
export type { CreatePageInput as SqliteCreatePageInput } from './page-repository.js';
export { SqliteExtractionRepository } from './extraction-repository.js';
export { SqliteEntityRepository, SqliteEntitySourceRepository } from './entity-repository.js';
export { SqliteSchemaRepository } from './schema-repository.js';
export { SqliteCrawlTaskRepository } from './crawl-task-repository.js';
export { SqliteActionRepository } from './action-repository.js';
export { SqliteSourceTrustRepository } from './source-trust-repository.js';

// Local-only repos (receive only db — no projectId)
export { RunRepository } from './run-repository.js';
export { LlmUsageRepository } from './llm-usage-repository.js';
export { SqliteExportRepository } from './export-repository.js';
export { ProjectMetaRepository } from './project-meta-repository.js';
