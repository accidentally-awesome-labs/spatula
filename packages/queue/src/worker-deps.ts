import type { Crawler, Extractor, ContentStore } from '@spatula/core';
import type { PageClassifier } from '@spatula/core';
import type {
  JobRepository,
  CrawlTaskRepository,
  PageRepository,
  ExtractionRepository,
  SchemaRepository,
} from '@spatula/db';
import type { SpatulaQueues } from './queues.js';

export interface WorkerDepsConfig {
  crawler: Crawler;
  extractor: Extractor;
  classifier: PageClassifier;
  contentStore: ContentStore;
  jobRepo: JobRepository;
  taskRepo: CrawlTaskRepository;
  pageRepo: PageRepository;
  extractionRepo: ExtractionRepository;
  schemaRepo: SchemaRepository;
  queues: SpatulaQueues;
}

export class WorkerDeps {
  readonly crawler: Crawler;
  readonly extractor: Extractor;
  readonly classifier: PageClassifier;
  readonly contentStore: ContentStore;
  readonly jobRepo: JobRepository;
  readonly taskRepo: CrawlTaskRepository;
  readonly pageRepo: PageRepository;
  readonly extractionRepo: ExtractionRepository;
  readonly schemaRepo: SchemaRepository;
  readonly queues: SpatulaQueues;

  constructor(config: WorkerDepsConfig) {
    this.crawler = config.crawler;
    this.extractor = config.extractor;
    this.classifier = config.classifier;
    this.contentStore = config.contentStore;
    this.jobRepo = config.jobRepo;
    this.taskRepo = config.taskRepo;
    this.pageRepo = config.pageRepo;
    this.extractionRepo = config.extractionRepo;
    this.schemaRepo = config.schemaRepo;
    this.queues = config.queues;
  }
}
