/**
 * SQLite schema parity verification against Postgres schemas.
 *
 * Ensures that every Postgres column (minus tenantId and known-dropped columns)
 * is present in the corresponding SQLite table, and documents intentional
 * local extensions that SQLite adds.
 *
 * Also includes smoke tests for DB initialization and Drizzle round-trips.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import Database from 'better-sqlite3';

// Postgres schemas
import { rawPages } from '../../../src/schema/raw-pages.js';
import { schemasTable as pgSchemasTable } from '../../../src/schema/schemas.js';
import { crawlTasks as pgCrawlTasks } from '../../../src/schema/crawl-tasks.js';
import { entities as pgEntities } from '../../../src/schema/entities.js';
import { entitySources as pgEntitySources } from '../../../src/schema/entities.js';
import { extractions as pgExtractions } from '../../../src/schema/extractions.js';
import { actions as pgActions } from '../../../src/schema/actions.js';
import { sourceTrust as pgSourceTrust } from '../../../src/schema/source-trust.js';

// SQLite schemas
import { pages as sqlitePages } from '../../../src/schema-sqlite/pages.js';
import { schemasTable as sqliteSchemasTable } from '../../../src/schema-sqlite/schemas.js';
import { crawlTasks as sqliteCrawlTasks } from '../../../src/schema-sqlite/crawl-tasks.js';
import { entities as sqliteEntities } from '../../../src/schema-sqlite/entities.js';
import { entitySources as sqliteEntitySources } from '../../../src/schema-sqlite/entities.js';
import { extractions as sqliteExtractions } from '../../../src/schema-sqlite/extractions.js';
import { actions as sqliteActions } from '../../../src/schema-sqlite/actions.js';
import { sourceTrust as sqliteSourceTrust } from '../../../src/schema-sqlite/source-trust.js';

// Connection factory + local-only schemas
import { createProjectDb, initializeProjectDb } from '../../../src/project-db/connection.js';
import type { ProjectDatabase, ProjectDbResult } from '../../../src/project-db/connection.js';
import { projectMeta } from '../../../src/schema-sqlite/project-meta.js';
import { runs } from '../../../src/schema-sqlite/runs.js';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colNames(table: Parameters<typeof getTableColumns>[0]): Set<string> {
  return new Set(Object.keys(getTableColumns(table)));
}

/**
 * Assert that every Postgres column (minus exclusions) exists in the SQLite table,
 * and that known local extensions exist in SQLite.
 */
function assertColumnParity(
  label: string,
  pgTable: Parameters<typeof getTableColumns>[0],
  sqliteTable: Parameters<typeof getTableColumns>[0],
  opts: {
    pgExclusions?: string[];
    sqliteExtensions?: string[];
  } = {},
) {
  const pgCols = colNames(pgTable);
  const sqliteCols = colNames(sqliteTable);
  const exclusions = new Set(opts.pgExclusions ?? []);
  const extensions = opts.sqliteExtensions ?? [];

  // Every Postgres column (minus exclusions) must exist in SQLite
  for (const col of pgCols) {
    if (exclusions.has(col)) continue;
    expect(sqliteCols.has(col), `${label}: Postgres column '${col}' missing in SQLite`).toBe(true);
  }

  // Known local extensions must exist in SQLite
  for (const ext of extensions) {
    expect(
      sqliteCols.has(ext),
      `${label}: expected local extension '${ext}' missing in SQLite`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// 1. Column Parity Tests
// ---------------------------------------------------------------------------

describe('SQLite ↔ Postgres column parity', () => {
  it('pages mirrors rawPages (minus tenantId, plus local extensions)', () => {
    assertColumnParity('pages', rawPages, sqlitePages, {
      pgExclusions: ['tenantId'],
      // Merged from crawl_tasks (denormalized for local query convenience):
      //   jobId, url, statusCode, title, classification
      // Purely local extensions (not in any Postgres table):
      //   contentPath, needsReextraction, reextractionReason
      sqliteExtensions: [
        'jobId',
        'url',
        'statusCode',
        'title',
        'classification',
        'contentPath',
        'needsReextraction',
        'reextractionReason',
      ],
    });
  });

  it('schemasTable mirrors pgSchemasTable (minus tenantId)', () => {
    assertColumnParity('schemasTable', pgSchemasTable, sqliteSchemasTable, {
      pgExclusions: ['tenantId'],
    });
  });

  it('crawlTasks mirrors pgCrawlTasks (minus tenantId, plus local extensions)', () => {
    assertColumnParity('crawlTasks', pgCrawlTasks, sqliteCrawlTasks, {
      pgExclusions: ['tenantId'],
      sqliteExtensions: ['priorityScore', 'errorMessage', 'attempts', 'completedAt'],
    });
  });

  it('entities mirrors pgEntities (minus tenantId, plus local extensions)', () => {
    assertColumnParity('entities', pgEntities, sqliteEntities, {
      pgExclusions: ['tenantId'],
      sqliteExtensions: ['sourceCount', 'updatedAt'],
    });
  });

  it('entitySources mirrors pgEntitySources (no tenantId to drop)', () => {
    assertColumnParity('entitySources', pgEntitySources, sqliteEntitySources);
  });

  it('extractions mirrors pgExtractions (minus tenantId)', () => {
    assertColumnParity('extractions', pgExtractions, sqliteExtractions, {
      pgExclusions: ['tenantId'],
    });
  });

  it('actions mirrors pgActions (minus tenantId)', () => {
    assertColumnParity('actions', pgActions, sqliteActions, {
      pgExclusions: ['tenantId'],
    });
  });

  it('sourceTrust mirrors pgSourceTrust (minus tenantId and reasoning, plus score/createdAt)', () => {
    // Spec deviation: Postgres has `reasoning NOT NULL` — SQLite drops it, adds score + createdAt
    assertColumnParity('sourceTrust', pgSourceTrust, sqliteSourceTrust, {
      pgExclusions: ['tenantId', 'reasoning'],
      sqliteExtensions: ['score', 'createdAt'],
    });
  });

  it('no unexpected columns lost in any mirrored table', () => {
    // Comprehensive check: collect all Postgres columns that are NOT in SQLite
    // (excluding known exclusions). If any are missing, the test above would
    // have caught it, but this provides a summary view.
    const pairs: Array<{
      label: string;
      pg: Parameters<typeof getTableColumns>[0];
      sqlite: Parameters<typeof getTableColumns>[0];
      exclude: string[];
    }> = [
      { label: 'pages', pg: rawPages, sqlite: sqlitePages, exclude: ['tenantId'] },
      {
        label: 'schemasTable',
        pg: pgSchemasTable,
        sqlite: sqliteSchemasTable,
        exclude: ['tenantId'],
      },
      { label: 'crawlTasks', pg: pgCrawlTasks, sqlite: sqliteCrawlTasks, exclude: ['tenantId'] },
      { label: 'entities', pg: pgEntities, sqlite: sqliteEntities, exclude: ['tenantId'] },
      { label: 'entitySources', pg: pgEntitySources, sqlite: sqliteEntitySources, exclude: [] },
      { label: 'extractions', pg: pgExtractions, sqlite: sqliteExtractions, exclude: ['tenantId'] },
      { label: 'actions', pg: pgActions, sqlite: sqliteActions, exclude: ['tenantId'] },
      {
        label: 'sourceTrust',
        pg: pgSourceTrust,
        sqlite: sqliteSourceTrust,
        exclude: ['tenantId', 'reasoning'],
      },
    ];

    const missing: string[] = [];
    for (const { label, pg, sqlite, exclude } of pairs) {
      const pgCols = colNames(pg);
      const sqliteCols = colNames(sqlite);
      const excSet = new Set(exclude);
      for (const col of pgCols) {
        if (excSet.has(col)) continue;
        if (!sqliteCols.has(col)) {
          missing.push(`${label}.${col}`);
        }
      }
    }

    expect(missing, `Missing Postgres columns in SQLite: ${missing.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. DB Initialization Smoke Test
// ---------------------------------------------------------------------------

describe('SQLite DB initialization', () => {
  let result: ProjectDbResult;

  beforeAll(() => {
    result = createProjectDb(':memory:');
    initializeProjectDb(result.db, {
      projectId: 'test-project-001',
      name: 'Test Project',
    });
  });

  afterAll(() => {
    result.sqlite.close();
  });

  it('project_meta contains schema_version after initialization', () => {
    const row = result.db
      .select()
      .from(projectMeta)
      .where(eq(projectMeta.key, 'schema_version'))
      .get();

    expect(row).toBeDefined();
    expect(row!.key).toBe('schema_version');
    expect(row!.value).toBe('1');
  });

  it('project_meta contains project_id after initialization', () => {
    const row = result.db.select().from(projectMeta).where(eq(projectMeta.key, 'project_id')).get();

    expect(row).toBeDefined();
    expect(row!.key).toBe('project_id');
    expect(row!.value).toBe('test-project-001');
  });

  it('project_meta contains project_name after initialization', () => {
    const row = result.db
      .select()
      .from(projectMeta)
      .where(eq(projectMeta.key, 'project_name'))
      .get();

    expect(row).toBeDefined();
    expect(row!.value).toBe('Test Project');
  });

  it('project_meta contains created_at after initialization', () => {
    const row = result.db.select().from(projectMeta).where(eq(projectMeta.key, 'created_at')).get();

    expect(row).toBeDefined();
    expect(row!.value).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  });
});

// ---------------------------------------------------------------------------
// 3. Drizzle Round-Trip Tests
// ---------------------------------------------------------------------------

describe('Drizzle ORM round-trip', () => {
  let result: ProjectDbResult;

  beforeAll(() => {
    result = createProjectDb(':memory:');
    initializeProjectDb(result.db, {
      projectId: 'roundtrip-project',
      name: 'Round-trip Test',
    });
  });

  afterAll(() => {
    result.sqlite.close();
  });

  it('insert and read back from projectMeta', () => {
    result.db.insert(projectMeta).values({ key: 'custom_setting', value: 'hello world' }).run();

    const row = result.db
      .select()
      .from(projectMeta)
      .where(eq(projectMeta.key, 'custom_setting'))
      .get();

    expect(row).toBeDefined();
    expect(row!.key).toBe('custom_setting');
    expect(row!.value).toBe('hello world');
  });

  it('insert and read back from runs (JSON column round-trip)', () => {
    const configSnapshot = {
      seedUrls: ['https://example.com'],
      maxDepth: 3,
      models: { fast: 'gpt-4o-mini', primary: 'gpt-4o' },
    };

    result.db
      .insert(runs)
      .values({
        id: 'run-001',
        status: 'running',
        source: 'local',
        configSnapshot,
        startedAt: new Date().toISOString(),
      })
      .run();

    const row = result.db.select().from(runs).where(eq(runs.id, 'run-001')).get();

    expect(row).toBeDefined();
    expect(row!.id).toBe('run-001');
    expect(row!.status).toBe('running');
    expect(row!.source).toBe('local');

    // JSON round-trip: text({ mode: 'json' }) should serialize/deserialize
    expect(row!.configSnapshot).toEqual(configSnapshot);
    expect((row!.configSnapshot as Record<string, unknown>).maxDepth).toBe(3);
    expect((row!.configSnapshot as Record<string, unknown>).seedUrls).toEqual([
      'https://example.com',
    ]);
  });

  it('runs default counters are correct', () => {
    const row = result.db.select().from(runs).where(eq(runs.id, 'run-001')).get();

    expect(row).toBeDefined();
    expect(row!.pagesCrawled).toBe(0);
    expect(row!.pagesReextracted).toBe(0);
    expect(row!.entitiesCreated).toBe(0);
    expect(row!.llmTokensUsed).toBe(0);
    expect(row!.llmCostUsd).toBe(0);
  });
});
