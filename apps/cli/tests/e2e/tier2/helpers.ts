/**
 * Shared test helpers for Tier 2 LLM pipeline tests.
 *
 * Provides:
 *  - `isPlaywrightAvailable()` — headless Chromium probe
 *  - `isOllamaAvailable()` — local Ollama health check
 *  - `createFixtureProject()` — temp dir with spatula.yaml + initialised DB
 *  - `buildPipelineRunner()` — full DI wiring matching `run.ts`
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseProjectYaml,
  yamlToJobConfig,
  LocalContentStore,
  LocalPipelineRunner,
  CrawlerFactory,
  RobotsTxtChecker,
  InMemoryDomainRateLimiter,
  createLLMClient,
  PageClassifier,
  StaticExtractor,
  SchemaEvolverImpl,
  DataReconcilerImpl,
  LLMLinkEvaluator,
  resolveModel,
  LocalDataSource,
} from '@accidentally-awesome-labs/spatula-core';
import type { LLMClient, Crawler, DataSource } from '@accidentally-awesome-labs/spatula-core';
import {
  createProjectDb,
  initializeProjectDb,
  ProjectAdapter,
} from '@accidentally-awesome-labs/spatula-db';
import { slugifyPath } from '../../../src/local-project.js';

// ---------------------------------------------------------------------------
// Playwright availability check
// ---------------------------------------------------------------------------

export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ollama availability check
// ---------------------------------------------------------------------------

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Project fixture
// ---------------------------------------------------------------------------

export interface FixtureProject {
  projectDir: string;
  projectId: string;
  cleanup(): void;
}

export function createFixtureProject(fixturePort: number): FixtureProject {
  const projectDir = mkdtempSync(join(tmpdir(), 'spatula-tier2-'));
  const projectId = slugifyPath(projectDir);

  // Write spatula.yaml
  // Note: We seed multiple URLs explicitly because the crawl-orchestrator's
  // isValidCrawlUrl() blocks localhost links discovered during crawling.
  // In production, discovered links point to real domains and pass the check.
  const yaml = `
name: Tier 2 Pipeline Test
description: LLM pipeline integration test
seeds:
  - http://localhost:${fixturePort}/
  - http://localhost:${fixturePort}/products/widget-pro
  - http://localhost:${fixturePort}/products/widget-pro-deluxe
  - http://localhost:${fixturePort}/products/comparison
  - http://localhost:${fixturePort}/recipes/pasta-carbonara
  - http://localhost:${fixturePort}/about
  - http://localhost:${fixturePort}/blog/review
  - http://localhost:${fixturePort}/page/2
depth: 2
limit: 20
llm:
  model: llama3.2:1b
schema:
  evolution:
    batchSize: 5
fields:
  - field: title
    type: string
    required: true
  - field: price
    type: currency
`;
  writeFileSync(join(projectDir, 'spatula.yaml'), yaml);

  // Initialize .spatula directory structure
  const dbDir = join(projectDir, '.spatula');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dbDir, 'pages'), { recursive: true });
  mkdirSync(join(dbDir, 'logs'), { recursive: true });

  // Create and initialise the SQLite project database
  const dbPath = join(dbDir, 'project.db');
  const { db, close } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId, name: 'Tier 2 Pipeline Test' });

  // LocalPipelineRunner must bootstrap schema version 1 from spatula.yaml.
  // Keeping the fixture database schema-free makes this an end-to-end regression
  // test for the same fresh-project path used by guided onboarding and `spatula run`.
  close();

  return {
    projectDir,
    projectId,
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Pipeline runner builder
// ---------------------------------------------------------------------------

export interface PipelineTestHarness {
  runner: InstanceType<typeof LocalPipelineRunner>;
  adapter: ProjectAdapter;
  dataSource: DataSource;
  crawler: Crawler;
  closeAll(): Promise<void>;
}

export async function buildPipelineRunner(
  projectDir: string,
  opts: { ollamaBaseUrl: string; fixturePort: number },
): Promise<PipelineTestHarness> {
  const projectId = slugifyPath(projectDir);

  // Read and parse spatula.yaml
  const yamlContent = readFileSync(join(projectDir, 'spatula.yaml'), 'utf-8');
  const projectYaml = parseProjectYaml(yamlContent);

  const jobConfig = yamlToJobConfig(projectYaml, {
    tenantId: projectId,
    projectId,
    projectRoot: projectDir,
    globalConfig: null,
  });

  // Open SQLite DB
  const dbPath = join(projectDir, '.spatula', 'project.db');
  const { db, close: closeDb } = createProjectDb(dbPath);
  const adapter = new ProjectAdapter(db, projectId);

  // Content store
  const contentStore = new LocalContentStore(join(projectDir, '.spatula', 'pages'));

  // LLM client pointed at mock Ollama
  const llmClient: LLMClient = createLLMClient({
    provider: 'ollama',
    ollama: { baseUrl: opts.ollamaBaseUrl },
  });

  const llmConfig = jobConfig.llm ?? { primaryModel: 'llama3.2:1b' };

  // Crawler (Playwright)
  const crawler = await CrawlerFactory.create({ type: 'playwright' });

  // LLM-dependent components (mirrors run.ts Step 9)
  const classifier = new PageClassifier(llmClient, llmConfig);
  const extractor = new StaticExtractor(llmClient, llmConfig, projectId);
  const schemaEvolver = new SchemaEvolverImpl(llmClient, llmConfig);
  const reconciler = new DataReconcilerImpl(llmClient, llmConfig);
  const linkEvaluator = new LLMLinkEvaluator(llmClient, resolveModel(llmConfig, 'linkEvaluation'));

  // Infrastructure
  const robotsChecker = new RobotsTxtChecker();
  const rateLimiter = new InMemoryDomainRateLimiter();

  // DataSource for post-pipeline assertions
  const dataSource: DataSource = new LocalDataSource(adapter);

  // Build runner (mirrors run.ts Step 11)
  const runner = new LocalPipelineRunner({
    adapter,
    config: { ...jobConfig, export: projectYaml.export } as any,
    projectDir,
    crawler,
    extractor,
    classifier,
    contentStore,
    schemaEvolver,
    reconciler,
    linkEvaluator,
    robotsChecker,
    rateLimiter,
    force: true, // Skip lock for tests
  } as any);

  return {
    runner,
    adapter,
    dataSource,
    crawler,
    closeAll: async () => {
      await crawler.close().catch(() => {});
      closeDb();
    },
  };
}
