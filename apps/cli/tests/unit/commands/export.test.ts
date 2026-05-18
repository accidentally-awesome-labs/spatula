import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveOutputPath,
  validateFormat,
  createExporter,
  formatFileSize,
  runExportCommand,
} from '../../../src/commands/export.js';
import type { Entity } from '@spatula/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClose = vi.fn();

vi.mock('../../../src/local-project.js', () => ({
  openLocalProject: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 1234 }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

const mockExportFn = vi.fn().mockResolvedValue({
  entityCount: 5,
  data: '[{"title":"test"}]',
  format: 'json',
  generatedAt: new Date(),
});

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    JsonExporter: vi.fn().mockImplementation(() => ({
      format: 'json',
      export: mockExportFn,
    })),
    CsvExporter: vi.fn().mockImplementation(() => ({
      format: 'csv',
      export: mockExportFn,
    })),
    SqliteExporter: vi.fn().mockImplementation(() => ({
      format: 'sqlite',
      export: vi.fn().mockResolvedValue({
        entityCount: 5,
        binaryData: new Uint8Array([1, 2, 3]),
        format: 'sqlite',
        generatedAt: new Date(),
      }),
    })),
    ParquetExporter: vi.fn().mockImplementation(() => ({
      format: 'parquet',
      export: vi.fn().mockResolvedValue({
        entityCount: 5,
        binaryData: new Uint8Array([1, 2, 3]),
        format: 'parquet',
        generatedAt: new Date(),
      }),
    })),
    DuckDBExporter: vi.fn().mockImplementation(() => ({
      format: 'duckdb',
      export: vi.fn().mockResolvedValue({
        entityCount: 5,
        binaryData: new Uint8Array([1, 2, 3]),
        format: 'duckdb',
        generatedAt: new Date(),
      }),
    })),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: overrides.id ?? `ent-${Math.random().toString(36).slice(2, 8)}`,
    jobId: 'job-1',
    mergedData: { title: 'Test' },
    categories: ['test'],
    qualityScore: overrides.qualityScore ?? 0.9,
    createdAt: '2026-03-30T00:00:00Z',
    sourceCount: 1,
    ...overrides,
  };
}

function createMockDataSource(entities: Entity[], schema: any) {
  return {
    getEntities: vi
      .fn()
      .mockImplementation(({ limit, offset }: { limit: number; offset: number }) => {
        const slice = entities.slice(offset, offset + limit);
        return Promise.resolve({ data: slice, total: entities.length });
      }),
    getSchema: vi.fn().mockResolvedValue(schema),
    getStatus: vi.fn().mockResolvedValue({ totalEntities: entities.length }),
  };
}

function createMockProject(entities: Entity[], schema: any) {
  const ds = createMockDataSource(entities, schema);
  mockClose.mockReset();
  return {
    dataSource: ds,
    projectRoot: '/fake/project',
    projectId: 'fake-project',
    close: mockClose,
  };
}

const DEFAULT_SCHEMA = {
  definition: {
    version: 1,
    fields: [{ name: 'title', type: 'string', required: true, description: 'Title' }],
    fieldAliases: [],
    createdAt: '2026-03-30T00:00:00Z',
    parentVersion: null,
  },
};

// ---------------------------------------------------------------------------
// validateFormat (existing tests retained)
// ---------------------------------------------------------------------------

describe('validateFormat', () => {
  it.each(['json', 'csv', 'sqlite', 'parquet', 'duckdb'] as const)(
    'accepts valid format "%s"',
    (format) => {
      expect(validateFormat(format)).toBe(format);
    },
  );

  it('throws for an invalid format', () => {
    expect(() => validateFormat('xlsx')).toThrow('Unsupported export format "xlsx"');
  });

  it('throws for empty string', () => {
    expect(() => validateFormat('')).toThrow('Unsupported export format');
  });
});

// ---------------------------------------------------------------------------
// resolveOutputPath (existing tests retained)
// ---------------------------------------------------------------------------

describe('resolveOutputPath', () => {
  it('returns the provided path resolved to absolute when given', () => {
    const result = resolveOutputPath('/tmp/my-export.json', 'json', '/project');
    expect(result).toBe('/tmp/my-export.json');
  });

  it('generates a default path under .spatula/exports with correct extension', () => {
    const result = resolveOutputPath(undefined, 'csv', '/my/project');
    expect(result).toMatch(/^\/my\/project\/\.spatula\/exports\//);
    expect(result).toMatch(/\.csv$/);
  });

  it('generates a default path with sqlite extension', () => {
    const result = resolveOutputPath(undefined, 'sqlite', '/proj');
    expect(result).toMatch(/\.sqlite$/);
  });

  it('generates a default path with parquet extension', () => {
    const result = resolveOutputPath(undefined, 'parquet', '/proj');
    expect(result).toMatch(/\.parquet$/);
  });

  it('generates a default path with duckdb extension', () => {
    const result = resolveOutputPath(undefined, 'duckdb', '/proj');
    expect(result).toMatch(/\.duckdb$/);
  });

  it('generates a default path with json extension', () => {
    const result = resolveOutputPath(undefined, 'json', '/proj');
    expect(result).toMatch(/\.json$/);
  });

  it('resolves a relative provided path to absolute', () => {
    const result = resolveOutputPath('output/data.json', 'json', '/project');
    // Should be resolved to an absolute path (based on cwd, not projectRoot)
    expect(result).toMatch(/^\/.*output\/data\.json$/);
  });
});

// ---------------------------------------------------------------------------
// createExporter
// ---------------------------------------------------------------------------

describe('createExporter', () => {
  it.each([
    ['json', 'json'],
    ['csv', 'csv'],
    ['sqlite', 'sqlite'],
    ['parquet', 'parquet'],
    ['duckdb', 'duckdb'],
  ] as const)('returns an exporter with format "%s"', (format, expectedFormat) => {
    const exporter = createExporter(format);
    expect(exporter).toBeDefined();
    expect(exporter.format).toBe(expectedFormat);
    expect(typeof exporter.export).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// formatFileSize
// ---------------------------------------------------------------------------

describe('formatFileSize', () => {
  it('formats bytes below 1 KB', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats bytes in the KB range', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10240)).toBe('10.0 KB');
  });

  it('formats bytes in the MB range', () => {
    expect(formatFileSize(1048576)).toBe('1.0 MB');
    expect(formatFileSize(1048576 * 2.5)).toBe('2.5 MB');
    expect(formatFileSize(1048576 * 100)).toBe('100.0 MB');
  });
});

// ---------------------------------------------------------------------------
// runExportCommand
// ---------------------------------------------------------------------------

describe('runExportCommand', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExportFn.mockClear();
  });

  afterEach(() => {
    mockExit.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  async function setupProject(entities: Entity[], schema: any) {
    const project = createMockProject(entities, schema);
    const { openLocalProject } = await import('../../../src/local-project.js');
    vi.mocked(openLocalProject).mockResolvedValue(project);
    return project;
  }

  it('exports entities with default format (json)', async () => {
    const entities = [makeEntity(), makeEntity(), makeEntity()];
    const project = await setupProject(entities, DEFAULT_SCHEMA);

    await runExportCommand({ output: '/tmp/test-export.json' });

    // Should have called getSchema and getEntities
    expect(project.dataSource.getSchema).toHaveBeenCalledOnce();
    expect(project.dataSource.getEntities).toHaveBeenCalled();

    // Should have called the exporter
    expect(mockExportFn).toHaveBeenCalledOnce();

    // Should print export summary
    const logCalls = consoleLogSpy.mock.calls.map((c) => c[0]);
    expect(logCalls).toContain('  Export complete');

    // Should close the project
    expect(project.close).toHaveBeenCalledOnce();
  });

  it('applies --min-quality filter and excludes low-quality entities', async () => {
    const entities = [
      makeEntity({ id: 'high-1', qualityScore: 0.9 }),
      makeEntity({ id: 'low-1', qualityScore: 0.3 }),
      makeEntity({ id: 'high-2', qualityScore: 0.8 }),
      makeEntity({ id: 'low-2', qualityScore: 0.1 }),
    ];
    const project = await setupProject(entities, DEFAULT_SCHEMA);

    await runExportCommand({ output: '/tmp/test-export.json', minQuality: 0.5 });

    // The exporter should receive only the 2 high-quality entities
    expect(mockExportFn).toHaveBeenCalledOnce();
    const exportedEntities = mockExportFn.mock.calls[0][0] as Entity[];
    expect(exportedEntities).toHaveLength(2);
    expect(exportedEntities.map((e) => e.id)).toEqual(['high-1', 'high-2']);

    expect(project.close).toHaveBeenCalledOnce();
  });

  it('batch-loads entities correctly with >200 entities', async () => {
    // Create 450 entities to test batching (200 + 200 + 50)
    const entities = Array.from({ length: 450 }, (_, i) => makeEntity({ id: `ent-${i}` }));
    const project = await setupProject(entities, DEFAULT_SCHEMA);

    await runExportCommand({ output: '/tmp/test-export.json' });

    // getEntities should be called 3 times: offset 0, 200, 400
    expect(project.dataSource.getEntities).toHaveBeenCalledTimes(3);
    expect(project.dataSource.getEntities).toHaveBeenNthCalledWith(1, {
      limit: 200,
      offset: 0,
    });
    expect(project.dataSource.getEntities).toHaveBeenNthCalledWith(2, {
      limit: 200,
      offset: 200,
    });
    expect(project.dataSource.getEntities).toHaveBeenNthCalledWith(3, {
      limit: 200,
      offset: 400,
    });

    // All 450 entities should be passed to exporter
    const exportedEntities = mockExportFn.mock.calls[0][0] as Entity[];
    expect(exportedEntities).toHaveLength(450);

    expect(project.close).toHaveBeenCalledOnce();
  });

  it('exits with error when no schema exists', async () => {
    const project = await setupProject([makeEntity()], null);

    await expect(runExportCommand({ output: '/tmp/test.json' })).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'No schema found. Run `spatula run` to crawl and build a schema first.',
    );
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(project.close).toHaveBeenCalledOnce();
  });

  it('exits with message when no entities match quality filter', async () => {
    const entities = [makeEntity({ qualityScore: 0.2 }), makeEntity({ qualityScore: 0.1 })];
    const project = await setupProject(entities, DEFAULT_SCHEMA);

    await runExportCommand({ output: '/tmp/test.json', minQuality: 0.9 });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'No entities match the given criteria. Nothing to export.',
    );
    // Exporter should NOT have been called
    expect(mockExportFn).not.toHaveBeenCalled();

    expect(project.close).toHaveBeenCalledOnce();
  });

  it('closes project in finally block even when exporter throws', async () => {
    const entities = [makeEntity()];
    const project = await setupProject(entities, DEFAULT_SCHEMA);

    mockExportFn.mockRejectedValueOnce(new Error('exporter boom'));

    await expect(runExportCommand({ output: '/tmp/test.json' })).rejects.toThrow('exporter boom');

    // close() should still be called despite the error
    expect(project.close).toHaveBeenCalledOnce();
  });

  it('exits with error when schema definition is missing', async () => {
    // Schema object exists but definition is null/undefined
    const project = await setupProject([makeEntity()], { definition: null });

    await expect(runExportCommand({ output: '/tmp/test.json' })).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'No schema found. Run `spatula run` to crawl and build a schema first.',
    );
    expect(project.close).toHaveBeenCalledOnce();
  });
});
