import type { Crawler, Extractor, ContentStore, SchemaEvolver, LinkEvaluator } from '@spatula/core';
import type { PageClassifier, DataReconciler } from '@spatula/core';
import type { RobotsTxtChecker, DomainRateLimiter, PageBudget, CrawlCompletionChecker } from '@spatula/core';
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
  ActionRepository,
  TenantRepository,
} from '@spatula/db';
import type { Pool } from 'pg';
import type { SpatulaQueues } from './queues.js';
import type { EventPublisher } from './events.js';

export interface WorkerDepsConfig {
  dbPool: Pool;
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
  actionRepo: ActionRepository;
  eventPublisher?: EventPublisher;
  linkEvaluator?: LinkEvaluator;
  robotsChecker?: RobotsTxtChecker;
  rateLimiter?: DomainRateLimiter;
  pageBudget?: PageBudget;
  completionChecker?: CrawlCompletionChecker;
  tenantRepo?: TenantRepository;
  queues: SpatulaQueues;
}

export class WorkerDeps {
  readonly dbPool: Pool;
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
  readonly actionRepo: ActionRepository;
  readonly eventPublisher?: EventPublisher;
  readonly linkEvaluator?: LinkEvaluator;
  readonly robotsChecker?: RobotsTxtChecker;
  readonly rateLimiter?: DomainRateLimiter;
  readonly pageBudget?: PageBudget;
  readonly completionChecker?: CrawlCompletionChecker;
  readonly tenantRepo?: TenantRepository;
  readonly queues: SpatulaQueues;

  constructor(config: WorkerDepsConfig) {
    this.dbPool = config.dbPool;
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
    this.actionRepo = config.actionRepo;
    this.eventPublisher = config.eventPublisher;
    this.linkEvaluator = config.linkEvaluator;
    this.robotsChecker = config.robotsChecker;
    this.rateLimiter = config.rateLimiter;
    this.pageBudget = config.pageBudget;
    this.completionChecker = config.completionChecker;
    this.tenantRepo = config.tenantRepo;
    this.queues = config.queues;
  }
}
