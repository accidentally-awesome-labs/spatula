/**
 * SQLite schema barrel — exports all table definitions for Drizzle Kit
 * migration generation and the project database connection factory.
 *
 * 7 mirrored from Postgres (minus tenantId, with intentional differences):
 *   pages, entities + entitySources, extractions, schemasTable,
 *   crawlTasks, actions, sourceTrust
 *
 * 4 local-only (no Postgres equivalent):
 *   runs, llmUsage, exports, projectMeta
 */

// Mirrored tables
export { pages } from './pages.js';
export { entities, entitySources } from './entities.js';
export { extractions } from './extractions.js';
export { schemasTable } from './schemas.js';
export { crawlTasks } from './crawl-tasks.js';
export { actions } from './actions.js';
export { sourceTrust } from './source-trust.js';

// Local-only tables
export { runs } from './runs.js';
export { llmUsage } from './llm-usage.js';
export { exports } from './exports.js';
export { projectMeta } from './project-meta.js';
