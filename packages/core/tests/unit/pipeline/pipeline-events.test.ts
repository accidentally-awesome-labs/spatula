import { describe, it, expect, vi } from 'vitest';
import { PipelineEventEmitter } from '../../../src/pipeline/pipeline-events.js';

describe('PipelineEventEmitter', () => {
  it('emits typed events', () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on('task:completed', handler);
    emitter.emit('task:completed', { id: '1', url: 'http://test', status: 'completed' });
    expect(handler).toHaveBeenCalledWith({ id: '1', url: 'http://test', status: 'completed' });
  });

  it('emits task failures with actionable details', () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on('task:failed', handler);
    emitter.emit('task:failed', {
      id: 'task-404',
      url: 'https://example.com/missing',
      error: 'HTTP 404 while crawling URL',
      retryable: false,
      attempts: 1,
      statusCode: 404,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-404', statusCode: 404, retryable: false }),
    );
  });

  it('emits progress events with stats', () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on('progress', handler);
    emitter.emit('progress', {
      pagesProcessed: 10,
      totalPages: 100,
      entitiesCreated: 5,
      errors: 1,
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ pagesProcessed: 10 }));
  });
});
