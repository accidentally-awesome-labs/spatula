// Types
export * from './types/index.js';

// Interfaces
export * from './interfaces/index.js';

// Crawlers (includes buildUserAgent + DEFAULT_USER_AGENT from crawler-defaults)
export * from './crawlers/index.js';

// LLM
export * from './llm/index.js';

// Extraction (includes scanOutput + OutputScanResult from output-scanner.ts)
export * from './extraction/index.js';

// Evolution
export * from './evolution/index.js';

// Reconciliation
export * from './reconciliation/index.js';

// Config
export * from './config/index.js';

// Exporters
export * from './exporters/index.js';

// Execution
export * from './execution/index.js';

// Link Evaluation
export * from './link-evaluation/index.js';

// Pipeline
export * from './pipeline/index.js';

// Cost
export * from './cost/index.js';

// Content Store
export * from './content-store/index.js';

// Diagnostics
export * from './diagnostics/index.js';

// DataSource interface and local implementation
export type {
  DataSource,
  PaginationQuery,
  PaginatedResult,
  ProjectStatus,
  DataEvent,
} from './interfaces/data-source.js';
export { LocalDataSource } from './pipeline/local-data-source.js';
