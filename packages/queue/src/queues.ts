import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

export const QUEUE_NAMES = {
  CRAWL: 'spatula:crawl',
  EXTRACT: 'spatula:extract',
  SCHEMA_EVOLUTION: 'spatula:schema-evolution',
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

export interface SpatulaQueues {
  crawl: Queue<CrawlJobData>;
  extract: Queue<ExtractJobData>;
  schemaEvolution: Queue<SchemaEvolutionJobData>;
  closeAll(): Promise<void>;
}

export function createQueues(connection: ConnectionOptions): SpatulaQueues {
  const crawl = new Queue<CrawlJobData>(QUEUE_NAMES.CRAWL, { connection });
  const extract = new Queue<ExtractJobData>(QUEUE_NAMES.EXTRACT, { connection });
  const schemaEvolution = new Queue<SchemaEvolutionJobData>(QUEUE_NAMES.SCHEMA_EVOLUTION, {
    connection,
  });

  return {
    crawl,
    extract,
    schemaEvolution,
    async closeAll() {
      await Promise.all([crawl.close(), extract.close(), schemaEvolution.close()]);
    },
  };
}
