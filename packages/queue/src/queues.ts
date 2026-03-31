import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { WebhookEvent } from '@spatula/shared';

export const QUEUE_NAMES = {
  CRAWL: 'spatula.crawl',
  EXTRACT: 'spatula.extract',
  SCHEMA_EVOLUTION: 'spatula.schema-evolution',
  RECONCILIATION: 'spatula.reconciliation',
  EXPORT: 'spatula.export',
  WEBHOOK: 'spatula.webhooks',
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
  minQuality?: number;
  fields?: string[];
}

export interface WebhookJobData {
  url: string;
  event: WebhookEvent;
  secret?: string;
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

/**
 * Per-queue retry configurations. Different failure modes need different strategies:
 * - Crawl: transient network failures → longer delays, more attempts
 * - Schema evolution: lock contention → flat retry, fewer attempts
 * - Export: resource exhaustion → moderate backoff
 */
export const QUEUE_JOB_OPTIONS = {
  [QUEUE_NAMES.CRAWL]: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 5_000 },  // 5s, 10s, 20s
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.EXTRACT]: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 2_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.SCHEMA_EVOLUTION]: {
    attempts: 2,
    backoff: { type: 'fixed' as const, delay: 10_000 },       // flat 10s retry (lock contention)
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.RECONCILIATION]: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 2_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.EXPORT]: {
    attempts: 2,
    backoff: { type: 'exponential' as const, delay: 3_000 },  // 3s, 6s
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
} as const;

export interface SpatulaQueues {
  crawl: Queue<CrawlJobData>;
  extract: Queue<ExtractJobData>;
  schemaEvolution: Queue<SchemaEvolutionJobData>;
  reconciliation: Queue<ReconciliationJobData>;
  export: Queue<ExportJobPayload>;
  webhook: Queue<WebhookJobData>;
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
    defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.CRAWL],
  });
  const extract = new Queue<ExtractJobData>(QUEUE_NAMES.EXTRACT, {
    connection,
    defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.EXTRACT],
  });
  const schemaEvolution = new Queue<SchemaEvolutionJobData>(QUEUE_NAMES.SCHEMA_EVOLUTION, {
    connection,
    defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.SCHEMA_EVOLUTION],
  });
  const reconciliation = new Queue<ReconciliationJobData>(QUEUE_NAMES.RECONCILIATION, {
    connection,
    defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.RECONCILIATION],
  });
  const exportQueue = new Queue<ExportJobPayload>(QUEUE_NAMES.EXPORT, {
    connection,
    defaultJobOptions: QUEUE_JOB_OPTIONS[QUEUE_NAMES.EXPORT],
  });
  const webhook = new Queue<WebhookJobData>(QUEUE_NAMES.WEBHOOK, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'custom' as const },  // Paired with worker's backoffStrategy: 1m, 5m, 30m
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  return {
    crawl,
    extract,
    schemaEvolution,
    reconciliation,
    export: exportQueue,
    webhook,
    config,
    async closeAll() {
      await Promise.all([
        crawl.close(),
        extract.close(),
        schemaEvolution.close(),
        reconciliation.close(),
        exportQueue.close(),
        webhook.close(),
      ]);
    },
  };
}
