import type { Crawler, Extractor, ContentStore, SchemaEvolver } from '@spatula/core';
import type { PageClassifier, DataReconciler } from '@spatula/core';
import type {
  JobRepository,
  CrawlTaskRepository,
  PageRepository,
  ExtractionRepository,
  SchemaRepository,
  EntityRepository,
  SourceTrustRepository,
  EntitySourceRepository,
  ExportRepository,
} from '@spatula/db';
import type { SpatulaQueues } from './queues.js';

export interface WorkerDepsConfig {
  crawler: Crawler;
  extractor: Extractor;
  classifier: PageClassifier;
  contentStore: ContentStore;
  schemaEvolver: SchemaEvolver;
  reconciler: DataReconciler;
  jobRepo: JobRepository;
  taskRepo: CrawlTaskRepository;
  pageRepo: PageRepository;
  extractionRepo: ExtractionRepository;
  schemaRepo: SchemaRepository;
  entityRepo: EntityRepository;
  sourceTrustRepo: SourceTrustRepository;
  entitySourceRepo: EntitySourceRepository;
  exportRepo: ExportRepository;
  queues: SpatulaQueues;
}

export class WorkerDeps {
  readonly crawler: Crawler;
  readonly extractor: Extractor;
  readonly classifier: PageClassifier;
  readonly contentStore: ContentStore;
  readonly schemaEvolver: SchemaEvolver;
  readonly reconciler: DataReconciler;
  readonly jobRepo: JobRepository;
  readonly taskRepo: CrawlTaskRepository;
  readonly pageRepo: PageRepository;
  readonly extractionRepo: ExtractionRepository;
  readonly schemaRepo: SchemaRepository;
  readonly entityRepo: EntityRepository;
  readonly sourceTrustRepo: SourceTrustRepository;
  readonly entitySourceRepo: EntitySourceRepository;
  readonly exportRepo: ExportRepository;
  readonly queues: SpatulaQueues;

  constructor(config: WorkerDepsConfig) {
    this.crawler = config.crawler;
    this.extractor = config.extractor;
    this.classifier = config.classifier;
    this.contentStore = config.contentStore;
    this.schemaEvolver = config.schemaEvolver;
    this.reconciler = config.reconciler;
    this.jobRepo = config.jobRepo;
    this.taskRepo = config.taskRepo;
    this.pageRepo = config.pageRepo;
    this.extractionRepo = config.extractionRepo;
    this.schemaRepo = config.schemaRepo;
    this.entityRepo = config.entityRepo;
    this.sourceTrustRepo = config.sourceTrustRepo;
    this.entitySourceRepo = config.entitySourceRepo;
    this.exportRepo = config.exportRepo;
    this.queues = config.queues;
  }
}
