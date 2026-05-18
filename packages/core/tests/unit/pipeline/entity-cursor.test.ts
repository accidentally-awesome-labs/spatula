import { describe, it, expect, vi } from 'vitest';
import { fetchEntitiesCursor } from '../../../src/pipeline/entity-cursor.js';

describe('fetchEntitiesCursor', () => {
  it('yields entity batches until no more results', async () => {
    const mockRepo = {
      findByJobCursor: vi
        .fn()
        .mockResolvedValueOnce({ entities: [{ id: '1' }, { id: '2' }], nextCursor: '2' })
        .mockResolvedValueOnce({ entities: [{ id: '3' }], nextCursor: null }),
    };

    const batches: unknown[][] = [];
    for await (const batch of fetchEntitiesCursor(mockRepo as any, 'job-1', 'tenant-1', 2)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
    expect(mockRepo.findByJobCursor).toHaveBeenCalledTimes(2);
  });

  it('yields nothing when no entities exist', async () => {
    const mockRepo = {
      findByJobCursor: vi.fn().mockResolvedValue({ entities: [], nextCursor: null }),
    };

    const batches: unknown[][] = [];
    for await (const batch of fetchEntitiesCursor(mockRepo as any, 'job-1', 'tenant-1', 500)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(0);
  });

  it('passes minQuality option to findByJobCursor', async () => {
    const mockRepo = {
      findByJobCursor: vi.fn().mockResolvedValue({ entities: [{ id: '1' }], nextCursor: null }),
    };
    const batches = [];
    for await (const batch of fetchEntitiesCursor(mockRepo as any, 'j1', 't1', 500, {
      minQuality: 0.7,
    })) {
      batches.push(batch);
    }
    expect(mockRepo.findByJobCursor).toHaveBeenCalledWith(
      'j1',
      't1',
      500,
      undefined,
      undefined,
      0.7,
    );
  });
});
