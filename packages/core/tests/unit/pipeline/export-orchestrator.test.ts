// packages/core/tests/unit/pipeline/export-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageError, ValidationError } from '@spatula/shared';
import type { ExportOrchestratorDeps, ExportInput, PipelineExportResult } from '../../../src/pipeline/types.js';

// Mock generateDocumentation at module level
vi.mock('../../../src/exporters/documentation-generator.js', () => ({
  generateDocumentation: vi.fn().mockReturnValue({
    jobId: 'job-1',
    schemaVersion: 1,
    generatedAt: '2026-03-22T00:00:00.000Z',
    entityCount: 0,
    fields: [],
  }),
}));

// Mock all exporter constructors
vi.mock('../../../src/exporters/json-exporter.js', () => ({
  JsonExporter: vi.fn().mockImplementation(() => ({
    format: 'json',
    export: vi.fn().mockResolvedValue({
      format: 'json',
      entityCount: 0,
      data: '[]',
      generatedAt: new Date(),
    }),
  })),
}));

vi.mock('../../../src/exporters/csv-exporter.js', () => ({
  CsvExporter: vi.fn().mockImplementation(() => ({
    format: 'csv',
    export: vi.fn().mockResolvedValue({
      format: 'csv',
      entityCount: 0,
      data: 'name\n',
      generatedAt: new Date(),
    }),
  })),
}));

vi.mock('../../../src/exporters/sqlite-exporter.js', () => ({
  SqliteExporter: vi.fn().mockImplementation(() => ({
    format: 'sqlite',
    export: vi.fn().mockResolvedValue({
      format: 'sqlite',
      entityCount: 0,
      binaryData: new Uint8Array([1, 2, 3]),
      generatedAt: new Date(),
    }),
  })),
}));

vi.mock('../../../src/exporters/parquet-exporter.js', () => ({
  ParquetExporter: vi.fn().mockImplementation(() => ({
    format: 'parquet',
    export: vi.fn().mockResolvedValue({
      format: 'parquet',
      entityCount: 0,
      binaryData: new Uint8Array([4, 5, 6]),
      generatedAt: new Date(),
    }),
  })),
}));

vi.mock('../../../src/exporters/duckdb-exporter.js', () => ({
  DuckDBExporter: vi.fn().mockImplementation(() => ({
    format: 'duckdb',
    export: vi.fn().mockResolvedValue({
      format: 'duckdb',
      entityCount: 0,
      binaryData: new Uint8Array([7, 8, 9]),
      generatedAt: new Date(),
    }),
  })),
}));

import { processExport } from '../../../src/pipeline/export-orchestrator.js';
import { generateDocumentation } from '../../../src/exporters/documentation-generator.js';

const defaultSchema = {
  version: 1,
  fields: [{ name: 'name', description: 'Name', type: 'string', required: true }],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

function createMockDeps(): ExportOrchestratorDeps {
  return {
    jobRepo: {
      findById: vi.fn().mockResolvedValue({ id: 'job-1', config: {}, status: 'completed' }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 1,
        definition: defaultSchema,
      }),
      create: vi.fn().mockResolvedValue(undefined),
    },
    entityRepo: {
      create: vi.fn().mockResolvedValue({ id: 'entity-1' }),
      findByJob: vi.fn().mockResolvedValue([]),
      findByJobWithProvenance: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    exportRepo: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue('pg://ref-1'),
      retrieve: vi.fn().mockResolvedValue(''),
      delete: vi.fn().mockResolvedValue(undefined),
      storeBinary: vi.fn().mockResolvedValue('pg://binary-ref-1'),
      retrieveBinary: vi.fn().mockResolvedValue(null),
    },
  };
}

const defaultInput: ExportInput = {
  exportId: 'exp-1',
  jobId: 'job-1',
  tenantId: 'tenant-1',
  format: 'json',
  includeProvenance: false,
};

describe('processExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks export as failed when job is not found', async () => {
    const deps = createMockDeps();
    (deps.jobRepo.findById as any).mockResolvedValue(null);

    await processExport(defaultInput, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('not found'),
      }),
    );
  });

  it('marks export as failed when job is not completed', async () => {
    const deps = createMockDeps();
    (deps.jobRepo.findById as any).mockResolvedValue({ id: 'job-1', status: 'running' });

    await processExport(defaultInput, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('not completed'),
      }),
    );
    // Should not attempt to process export
    expect(deps.contentStore.store).not.toHaveBeenCalled();
  });

  it('marks export as failed when entity count exceeds MAX_EXPORT_ENTITIES', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.countByJob as any).mockResolvedValue(60_000);

    await processExport(defaultInput, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('50,000'),
      }),
    );
  });

  it('transitions status: processing then completed for JSON export', async () => {
    const deps = createMockDeps();
    await processExport(defaultInput, deps);

    const calls = (deps.exportRepo.updateStatus as any).mock.calls;
    expect(calls[0]).toEqual([
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'processing' }),
    ]);
    expect(calls[calls.length - 1]).toEqual([
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'completed' }),
    ]);
  });

  it('stores text content and includes documentation for JSON export', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);

    await processExport(defaultInput, deps);

    expect(deps.contentStore.store).toHaveBeenCalled();
    const storedContent = (deps.contentStore.store as any).mock.calls[0][1];
    const envelope = JSON.parse(storedContent);
    expect(envelope).toHaveProperty('metadata');
    expect(envelope).toHaveProperty('schema');
    expect(envelope).toHaveProperty('documentation');
    expect(envelope).toHaveProperty('entities');
    expect(envelope.metadata.format).toBe('json');
    expect(envelope.metadata.entityCount).toBe(1);
    expect(generateDocumentation).toHaveBeenCalled();
  });

  it('stores text content for CSV export', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);

    const csvInput = { ...defaultInput, format: 'csv' as const };
    await processExport(csvInput, deps);

    expect(deps.contentStore.store).toHaveBeenCalledWith(
      expect.stringContaining('.csv'),
      expect.any(String),
    );
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('stores binary content for sqlite format', async () => {
    const deps = createMockDeps();
    const sqliteInput = { ...defaultInput, format: 'sqlite' as const };

    await processExport(sqliteInput, deps);

    expect(deps.contentStore.storeBinary).toHaveBeenCalled();
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ status: 'completed', contentRef: 'pg://binary-ref-1' }),
    );
  });

  it('stores binary content for parquet format', async () => {
    const deps = createMockDeps();
    const parquetInput = { ...defaultInput, format: 'parquet' as const };

    await processExport(parquetInput, deps);

    expect(deps.contentStore.storeBinary).toHaveBeenCalled();
  });

  it('stores binary content for duckdb format', async () => {
    const deps = createMockDeps();
    const duckdbInput = { ...defaultInput, format: 'duckdb' as const };

    await processExport(duckdbInput, deps);

    expect(deps.contentStore.storeBinary).toHaveBeenCalled();
  });

  it('marks export as failed on error', async () => {
    const deps = createMockDeps();
    (deps.schemaRepo.findLatest as any).mockRejectedValue(new Error('db error'));

    await processExport(defaultInput, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('db error') }),
    );
  });

  it('marks export as failed when schema is not found', async () => {
    const deps = createMockDeps();
    (deps.schemaRepo.findLatest as any).mockResolvedValue(null);

    await processExport(defaultInput, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('No schema found'),
      }),
    );
    expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
    expect(deps.contentStore.store).not.toHaveBeenCalled();
  });

  it('completes with empty result for zero entities', async () => {
    const deps = createMockDeps();

    const result = await processExport(defaultInput, deps);

    expect(result).toEqual(expect.objectContaining({
      entityCount: 0,
    }));
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'completed', entityCount: 0 }),
    );
  });

  it('uses findByJobWithProvenance when provenance requested for JSON', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);
    (deps.entityRepo.findByJobWithProvenance as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);

    const provenanceInput = { ...defaultInput, includeProvenance: true };
    await processExport(provenanceInput, deps);

    expect(deps.entityRepo.findByJobWithProvenance).toHaveBeenCalled();
    expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
  });

  it('uses findByJob (not provenance) for non-JSON formats even with includeProvenance', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);

    const csvProvenanceInput = { ...defaultInput, format: 'csv' as const, includeProvenance: true };
    await processExport(csvProvenanceInput, deps);

    expect(deps.entityRepo.findByJob).toHaveBeenCalled();
    expect(deps.entityRepo.findByJobWithProvenance).not.toHaveBeenCalled();
  });

  it('fails when content store write fails', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);
    (deps.contentStore.store as any).mockRejectedValue(new Error('S3 write timeout'));

    await processExport(defaultInput, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('S3 write timeout'),
      }),
    );
  });

  it('returns PipelineExportResult on success', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);

    const result = await processExport(defaultInput, deps);

    expect(result).toHaveProperty('entityCount', 1);
    expect(result).toHaveProperty('contentRef', 'pg://ref-1');
    expect(result).toHaveProperty('fileSize');
    expect(typeof result.fileSize).toBe('number');
    expect(result.fileSize).toBeGreaterThan(0);
  });

  it('uses custom maxEntities from input when provided', async () => {
    const deps = createMockDeps();
    // 15 entities — above a custom limit of 10
    (deps.entityRepo.countByJob as any).mockResolvedValue(15);

    const customInput = { ...defaultInput, maxEntities: 10 };
    await processExport(customInput, deps);

    // Should fail because 15 > 10 (the custom limit)
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('10'),
      }),
    );
  });

  it('uses streaming CSV path when findByJobCursor is available', async () => {
    const deps = createMockDeps();
    const entities = [
      { id: 'e1', mergedData: { name: 'Alice' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
      { id: 'e2', mergedData: { name: 'Bob' }, qualityScore: 0.8, categories: [], sourceCount: 1 },
    ];
    // Add findByJobCursor to trigger streaming path
    (deps.entityRepo as any).findByJobCursor = vi.fn()
      .mockResolvedValueOnce({ entities, nextCursor: null });

    const csvInput = { ...defaultInput, format: 'csv' as const };
    const result = await processExport(csvInput, deps);

    // Streaming path should use findByJobCursor, not findByJob
    expect((deps.entityRepo as any).findByJobCursor).toHaveBeenCalledWith('job-1', 'tenant-1', 500, undefined);
    expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
    // countByJob is now called for ALL paths (maxEntities guard)
    expect(deps.entityRepo.countByJob).toHaveBeenCalled();
    expect(result.entityCount).toBe(2);
    expect(deps.contentStore.store).toHaveBeenCalled();
    // Verify CSV content
    const storedContent = (deps.contentStore.store as any).mock.calls[0][1];
    expect(storedContent).toContain('name');
    expect(storedContent).toContain('Alice');
    expect(storedContent).toContain('Bob');
  });

  it('uses streaming JSON path when findByJobCursor is available and no provenance', async () => {
    const deps = createMockDeps();
    const entities = [
      { id: 'e1', mergedData: { name: 'Alice' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
      { id: 'e2', mergedData: { name: 'Bob' }, qualityScore: 0.8, categories: [], sourceCount: 1 },
    ];
    // Add findByJobCursor to trigger streaming path
    (deps.entityRepo as any).findByJobCursor = vi.fn()
      .mockResolvedValueOnce({ entities, nextCursor: null });

    const jsonInput = { ...defaultInput, format: 'json' as const, includeProvenance: false };
    const result = await processExport(jsonInput, deps);

    // Streaming path should use findByJobCursor, not findByJob
    expect((deps.entityRepo as any).findByJobCursor).toHaveBeenCalledWith('job-1', 'tenant-1', 500, undefined);
    expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
    // countByJob is called for ALL paths (maxEntities guard)
    expect(deps.entityRepo.countByJob).toHaveBeenCalled();
    // entityCount should match the number of entities yielded
    expect(result.entityCount).toBe(2);
    // Content should be stored
    expect(deps.contentStore.store).toHaveBeenCalled();
    // Parse and verify the JSON envelope structure
    const storedContent = (deps.contentStore.store as any).mock.calls[0][1];
    const envelope = JSON.parse(storedContent);
    expect(envelope.metadata.format).toBe('json');
    expect(Array.isArray(envelope.entities)).toBe(true);
    expect(envelope).toHaveProperty('schema');
  });

  it('falls back to offset path for JSON with provenance even when findByJobCursor is available', async () => {
    const deps = createMockDeps();
    const entities = [
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ];
    // Add findByJobCursor — but provenance should bypass it
    (deps.entityRepo as any).findByJobCursor = vi.fn();
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);
    (deps.entityRepo.findByJobWithProvenance as any).mockResolvedValue(entities);

    const provenanceInput = { ...defaultInput, includeProvenance: true };
    await processExport(provenanceInput, deps);

    // Should NOT use streaming/cursor path — provenance forces offset path
    expect((deps.entityRepo as any).findByJobCursor).not.toHaveBeenCalled();
    expect(deps.entityRepo.findByJobWithProvenance).toHaveBeenCalled();
    expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
  });

  it('uses cursor to collect entities for binary format when findByJobCursor is available', async () => {
    const deps = createMockDeps();
    const entities = [
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ];
    // Add findByJobCursor — binary format should collect via cursor then pass to exporter
    (deps.entityRepo as any).findByJobCursor = vi.fn()
      .mockResolvedValueOnce({ entities, nextCursor: null });
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);

    const parquetInput = { ...defaultInput, format: 'parquet' as const };
    await processExport(parquetInput, deps);

    // Should use cursor to collect (not streaming exporter), then pass to binary exporter
    expect((deps.entityRepo as any).findByJobCursor).toHaveBeenCalled();
    expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
    expect(deps.contentStore.storeBinary).toHaveBeenCalled();
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'completed', contentRef: 'pg://binary-ref-1' }),
    );
  });

  it('falls back to MAX_EXPORT_ENTITIES (50,000) when maxEntities not provided', async () => {
    const deps = createMockDeps();
    // 40,000 entities — under the default 50,000 limit
    (deps.entityRepo.countByJob as any).mockResolvedValue(40_000);
    (deps.entityRepo.findByJob as any).mockResolvedValue([]);

    await processExport(defaultInput, deps);

    // Should NOT fail — 40,000 < 50,000
    const calls = (deps.exportRepo.updateStatus as any).mock.calls;
    const finalCall = calls[calls.length - 1];
    expect(finalCall[2]).toEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('fetches entities in batches', async () => {
    const deps = createMockDeps();
    // 250 entities = 3 batches (100+100+50)
    (deps.entityRepo.countByJob as any).mockResolvedValue(250);
    const entities = Array.from({ length: 100 }, (_, i) => ({
      id: `e${i}`, mergedData: { name: `Test ${i}` }, qualityScore: 0.9, categories: [], sourceCount: 1,
    }));
    (deps.entityRepo.findByJob as any)
      .mockResolvedValueOnce(entities)       // batch 1: 100
      .mockResolvedValueOnce(entities)       // batch 2: 100
      .mockResolvedValueOnce(entities.slice(0, 50)); // batch 3: 50

    await processExport(defaultInput, deps);

    expect(deps.entityRepo.findByJob).toHaveBeenCalledTimes(3);
    expect(deps.entityRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', { limit: 100, offset: 0 });
    expect(deps.entityRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', { limit: 100, offset: 100 });
    expect(deps.entityRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', { limit: 100, offset: 200 });
  });
});
