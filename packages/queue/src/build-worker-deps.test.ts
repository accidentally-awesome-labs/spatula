import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted; factory runs before any imports
// ---------------------------------------------------------------------------

// Mock only the exports used by build-worker-deps.ts — do NOT use importOriginal
// here to avoid loading the real @spatula/core (which would try to launch Playwright
// when CrawlerFactory.create is called and cause a 5s timeout in the test worker).
vi.mock('@spatula/core', () => ({
  CrawlerFactory: {
    create: vi.fn().mockResolvedValue({ crawl: vi.fn(), close: vi.fn() }),
  },
  createLLMClient: vi.fn().mockReturnValue({ complete: vi.fn(), setUsageRecorder: vi.fn() }),
  CircuitBreakerLLMClient: vi.fn().mockImplementation((inner: unknown) => inner),
  PageClassifier: vi.fn().mockImplementation(() => ({})),
  StaticExtractor: vi.fn().mockImplementation(() => ({})),
  SchemaEvolverImpl: vi.fn().mockImplementation(() => ({})),
  DataReconcilerImpl: vi.fn().mockImplementation(() => ({})),
  LLMLinkEvaluator: vi.fn().mockImplementation(() => ({})),
  RobotsTxtChecker: vi.fn().mockImplementation(() => ({})),
  InMemoryDomainRateLimiter: vi.fn().mockImplementation(() => ({})),
  CrawlCompletionChecker: vi.fn().mockImplementation(() => ({})),
  resolveModel: vi.fn().mockReturnValue('deepseek/deepseek-v4-pro'),
  createContentStore: vi.fn().mockReturnValue({ type: 's3' }),
}));

vi.mock('@spatula/db', () => ({
  JobRepository: vi.fn().mockImplementation(() => ({})),
  CrawlTaskRepository: vi.fn().mockImplementation(() => ({})),
  PageRepository: vi.fn().mockImplementation(() => ({})),
  ExtractionRepository: vi.fn().mockImplementation(() => ({})),
  SchemaRepository: vi.fn().mockImplementation(() => ({})),
  EntityRepository: vi.fn().mockImplementation(() => ({})),
  EntitySourceRepository: vi.fn().mockImplementation(() => ({})),
  SourceTrustRepository: vi.fn().mockImplementation(() => ({})),
  ExportRepository: vi.fn().mockImplementation(() => ({})),
  ActionRepository: vi.fn().mockImplementation(() => ({})),
  TenantRepository: vi.fn().mockImplementation(() => ({})),
  PgContentStore: vi.fn().mockImplementation(() => ({ type: 'pg' })),
}));

vi.mock('@spatula/shared', () => ({
  createLogger: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getEnvOrDefault: vi.fn().mockImplementation((key: string, defaultValue: string) => {
    return process.env[key] ?? defaultValue;
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const FAKE_INPUT = {
  db: {} as any,
  pool: {} as any,
  queues: {} as any,
};

describe('buildWorkerDeps()', { timeout: 15_000 }, () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('Test 1: throws a clear error when OPENROUTER_API_KEY is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;

    const { buildWorkerDeps } = await import('./build-worker-deps.js');

    await expect(buildWorkerDeps(FAKE_INPUT)).rejects.toThrow('OPENROUTER_API_KEY');
  });

  it('Test 2: resolves to an object with non-null deps + clients when OPENROUTER_API_KEY is set', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key-abc';
    const eventPublisher = { publish: vi.fn() };

    const { buildWorkerDeps } = await import('./build-worker-deps.js');
    const result = await buildWorkerDeps({ ...FAKE_INPUT, eventPublisher });

    expect(result.deps).toBeDefined();
    expect(result.deps.extractor).toBeDefined();
    expect(result.deps.classifier).toBeDefined();
    expect(result.deps.schemaEvolver).toBeDefined();
    expect(result.deps.reconciler).toBeDefined();
    expect(result.deps.crawler).toBeDefined();
    expect(result.deps.contentStore).toBeDefined();
    expect(result.deps.eventPublisher).toBe(eventPublisher);
    expect(result.deps.jobRepo).toBeDefined();
    expect(result.deps.taskRepo).toBeDefined();
    expect(result.deps.pageRepo).toBeDefined();
    expect(result.deps.schemaRepo).toBeDefined();
    expect(result.deps.entityRepo).toBeDefined();
    expect(result.rawClient).toBeDefined();
    expect(result.llmClient).toBeDefined();
    expect(result.llmConfig).toBeDefined();
  });

  it('Test 3: when SPATULA_CRAWLER=firecrawl, CrawlerFactory.create is called with { type: firecrawl }', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key-abc';
    process.env.SPATULA_CRAWLER = 'firecrawl';
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    const { CrawlerFactory } = await import('@spatula/core');
    const { buildWorkerDeps } = await import('./build-worker-deps.js');

    await buildWorkerDeps(FAKE_INPUT);

    expect(CrawlerFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'firecrawl', firecrawlApiKey: 'fc-test-key' }),
    );
  });

  it('Test 4: when SPATULA_CRAWLER is unset, CrawlerFactory.create is called with { type: playwright }', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key-abc';
    delete process.env.SPATULA_CRAWLER;

    const { CrawlerFactory } = await import('@spatula/core');
    const { buildWorkerDeps } = await import('./build-worker-deps.js');

    await buildWorkerDeps(FAKE_INPUT);

    expect(CrawlerFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'playwright' }),
    );
  });
});
