import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

export const QUEUE_NAMES = {
  CRAWL: 'spatula.crawl',
  EXTRACT: 'spatula.extract',
  SCHEMA_EVOLUTION: 'spatula.schema-evolution',
  RECONCILIATION: 'spatula.reconciliation',
  EXPORT: 'spatula.export',
} as const;

export interface CrawlJobData {
  taskId: string;
  jobId: string;
  tenantId: string;
  url: string;
  depth: number;
}

export interface ExtractJobData {
  taskId: string;
  jobId: string;
  tenantId: string;
  pageId: string;
  contentRef: string;
  url: string;
}

export interface SchemaEvolutionJobData {
  jobId: string;
  tenantId: string;
  extractionIds: string[];
}

export interface ReconciliationJobData {
  jobId: string;
  tenantId: string;
}

export interface ExportJobPayload {
  exportId: string;
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv' | 'parquet' | 'duckdb' | 'sqlite';
  includeProvenance: boolean;
}

export interface QueueConfig {
  crawl: { concurrency: number; rateLimitMax: number; rateLimitDuration: number };
  extract: { concurrency: number };
  schemaEvolution: { concurrency: number };
  reconciliation: { concurrency: number };
  export: { concurrency: number };
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  crawl: { concurrency: 5, rateLimitMax: 10, rateLimitDuration: 1000 },
  extract: { concurrency: 3 },
  schemaEvolution: { concurrency: 1 },
  reconciliation: { concurrency: 1 },
  export: { concurrency: 2 },
};

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export interface SpatulaQueues {
  crawl: Queue<CrawlJobData>;
  extract: Queue<ExtractJobData>;
  schemaEvolution: Queue<SchemaEvolutionJobData>;
  reconciliation: Queue<ReconciliationJobData>;
  export: Queue<ExportJobPayload>;
  config: QueueConfig;
  closeAll(): Promise<void>;
}

export function createQueues(
  connection: ConnectionOptions,
  queueConfig?: QueueConfig,
): SpatulaQueues {
  const config = queueConfig ?? DEFAULT_QUEUE_CONFIG;

  const crawl = new Queue<CrawlJobData>(QUEUE_NAMES.CRAWL, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  const extract = new Queue<ExtractJobData>(QUEUE_NAMES.EXTRACT, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  const schemaEvolution = new Queue<SchemaEvolutionJobData>(QUEUE_NAMES.SCHEMA_EVOLUTION, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  const reconciliation = new Queue<ReconciliationJobData>(QUEUE_NAMES.RECONCILIATION, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  const exportQueue = new Queue<ExportJobPayload>(QUEUE_NAMES.EXPORT, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  return {
    crawl,
    extract,
    schemaEvolution,
    reconciliation,
    export: exportQueue,
    config,
    async closeAll() {
      await Promise.all([
        crawl.close(),
        extract.close(),
        schemaEvolution.close(),
        reconciliation.close(),
        exportQueue.close(),
      ]);
    },
  };
}
