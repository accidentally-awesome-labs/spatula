// packages/core/src/pipeline/types.ts
import type {
  Crawler,
  Extractor,
  ContentStore,
  SchemaEvolver,
  LinkEvaluator,
  PageClassifier,
  DataReconciler,
  Exporter,
  SchemaDefinition,
} from '../index.js';

// Re-export EventPublisher interface so orchestrators don't import from @spatula/queue
export interface EventPublisher {
  publish(jobId: string, event: { type: string; jobId: string; tenantId: string; data: unknown }): Promise<void>;
}

// --- Repository interfaces (narrowed from full repo types) ---
// These match the existing @spatula/db repository method signatures
// but are declared here so @spatula/core has no dependency on @spatula/db

export interface CrawlTaskRepo {
  updateStatus(taskId: string, tenantId: string, status: string): Promise<unknown>;
  updateClassification(taskId: string, tenantId: string, classification: string): Promise<unknown>;
  enqueue(data: { jobId: string; tenantId: string; url: string; depth: number; parentTaskId: string }): Promise<{ id: string }>;
}

export interface PageRepo {
  findByContentHash(hash: string, tenantId: string): Promise<{ id: string } | null>;
  findByIds(ids: string[], tenantId: string): Promise<Array<{ id: string; metadata: Record<string, unknown> | null; createdAt: Date }>>;
  create(data: {
    taskId: string;
    tenantId: string;
    contentRef: string;
    contentHash: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface ExtractionRepo {
  store(data: {
    jobId: string;
    tenantId: string;
    pageId: string;
    schemaVersion: number;
    data: Record<string, unknown>;
    unmappedFields: unknown[];
    metadata: unknown;
  }): Promise<unknown>;
  findByJob(jobId: string, tenantId: string, options?: { schemaVersion?: number; limit?: number; offset?: number }): Promise<Array<{
    id: string;
    jobId: string;
    pageId: string;
    schemaVersion: number;
    data: unknown;
    metadata: unknown;
  }>>;
}

export interface SchemaRepo {
  findLatest(jobId: string, tenantId: string): Promise<{ id: string; version: number; definition: SchemaDefinition } | null>;
  create(data: { jobId: string; tenantId: string; version: number; definition: SchemaDefinition; parentId?: string }): Promise<unknown>;
}

export interface JobRepo {
  findById(jobId: string, tenantId: string): Promise<{ id: string; config: unknown; status?: string } | null>;
  updateStatus(jobId: string, tenantId: string, status: string): Promise<unknown>;
}

export interface EntityRepo {
  create(data: { jobId: string; tenantId: string; mergedData: Record<string, unknown>; provenance: Record<string, unknown>; qualityScore: number }): Promise<{ id: string }>;
  findByJob(jobId: string, tenantId: string, options?: { limit: number; offset: number }): Promise<unknown[]>;
  findByJobWithProvenance(jobId: string, tenantId: string, options?: { limit: number; offset: number }): Promise<unknown[]>;
  countByJob(jobId: string, tenantId: string): Promise<number>;
}

export interface EntitySourceRepo {
  bulkLink(links: Array<{ entityId: string; extractionId: string; matchConfidence: number }>): Promise<unknown>;
}

export interface SourceTrustRepo {
  upsert(data: { jobId: string; tenantId: string; domain: string; trustLevel: string; reasoning: string }): Promise<unknown>;
}

export interface ActionRepo {
  create(data: {
    jobId: string;
    tenantId: string;
    type: string;
    payload: unknown;
    source: string;
    status: string;
    confidence?: number;
    reasoning?: string;
  }): Promise<unknown>;
}

export interface ExportRepo {
  updateStatus(exportId: string, tenantId: string, data: {
    status: 'processing' | 'completed' | 'failed';
    entityCount?: number;
    contentRef?: string;
    fileSize?: number;
    error?: string;
    completedAt?: Date;
  }): Promise<unknown>;
}

// --- Orchestrator dependency bundles ---

export interface CrawlOrchestratorDeps {
  crawler: Crawler;
  classifier: PageClassifier;
  extractor: Extractor;
  contentStore: ContentStore;
  linkEvaluator?: LinkEvaluator;
  taskRepo: CrawlTaskRepo;
  pageRepo: PageRepo;
  jobRepo: JobRepo;
  extractionRepo: ExtractionRepo;
  schemaRepo: SchemaRepo;
  eventPublisher?: EventPublisher;
}

export interface SchemaOrchestratorDeps {
  schemaEvolver: SchemaEvolver;
  jobRepo: JobRepo;
  extractionRepo: ExtractionRepo;
  schemaRepo: SchemaRepo;
  actionRepo: ActionRepo;
  eventPublisher?: EventPublisher;
}

export interface ReconcileOrchestratorDeps {
  reconciler: DataReconciler;
  jobRepo: JobRepo;
  schemaRepo: SchemaRepo;
  extractionRepo: ExtractionRepo;
  pageRepo: PageRepo;
  entityRepo: EntityRepo;
  entitySourceRepo: EntitySourceRepo;
  sourceTrustRepo: SourceTrustRepo;
  eventPublisher?: EventPublisher;
}

export interface ExportOrchestratorDeps {
  jobRepo: JobRepo;
  schemaRepo: SchemaRepo;
  entityRepo: EntityRepo;
  exportRepo: ExportRepo;
  contentStore: ContentStore;
}

// --- Input/Output types ---

export interface CrawlTaskInput {
  taskId: string;
  jobId: string;
  tenantId: string;
  url: string;
  depth: number;
}

export interface LinkToEnqueue {
  url: string;
  text?: string;
  rel?: string;
  priority?: string;
  relevanceScore?: number;
}

export interface CrawlTaskResult {
  pageId: string;
  classification: string;
  extracted: boolean;
  linksFound: LinkToEnqueue[];
  contentHash: string;
  deduplicated: boolean;
  schemaVersion: number | null;
  evolutionConfig: { enabled: boolean; batchSize: number } | null;
  error?: Error;  // Set if the task failed
}

export interface SchemaEvolutionInput {
  jobId: string;
  tenantId: string;
  extractionIds: string[];  // Note: currently unused by the orchestrator (it fetches latest batch from DB).
                            // Preserved for backward compat with queue job data. Future optimization:
                            // use these IDs to fetch specific extractions instead of latest N.
}

export interface SchemaEvolutionResult {
  evolved: boolean;
  newVersion?: number;
  actionsApplied: number;
}

export interface ReconciliationInput {
  jobId: string;
  tenantId: string;
}

export interface PipelineReconciliationResult {
  entitiesCreated: number;
  actionsGenerated: number;
}

export interface ExportInput {
  exportId: string;
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv' | 'parquet' | 'duckdb' | 'sqlite';
  includeProvenance: boolean;
  maxEntities?: number;
}

export interface PipelineExportResult {
  entityCount: number;
  fileSize: number;
  contentRef: string;
}
