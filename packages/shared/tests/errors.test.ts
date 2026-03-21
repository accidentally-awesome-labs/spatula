import { describe, it, expect } from 'vitest';
import {
  SpatulaError,
  ValidationError,
  CrawlError,
  ExtractionError,
  LLMError,
  ConfigError,
  StorageError,
  QueueError,
  TimeoutError,
  RateLimitError,
  NetworkError,
  StateError,
} from '../src/errors.js';

describe('SpatulaError', () => {
  it('is an instance of Error', () => {
    const err = new SpatulaError('test', 'TEST_ERROR');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpatulaError);
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST_ERROR');
    expect(err.name).toBe('SpatulaError');
  });

  it('supports optional cause', () => {
    const cause = new Error('root');
    const err = new SpatulaError('wrapper', 'WRAP', { cause });
    expect(err.cause).toBe(cause);
  });

  it('supports optional context', () => {
    const err = new SpatulaError('test', 'TEST', { context: { jobId: '123' } });
    expect(err.context).toEqual({ jobId: '123' });
  });

  it('defaults retryable to false', () => {
    const err = new SpatulaError('test', 'TEST_ERROR');
    expect(err.retryable).toBe(false);
  });

  it('supports retryable option', () => {
    const err = new SpatulaError('test', 'TEST_ERROR', { retryable: true });
    expect(err.retryable).toBe(true);
  });
});

describe('error subclasses', () => {
  it('ValidationError has correct name and code prefix', () => {
    const err = new ValidationError('bad input');
    expect(err.name).toBe('ValidationError');
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('CrawlError has correct name', () => {
    const err = new CrawlError('timeout', { context: { url: 'http://example.com' } });
    expect(err.name).toBe('CrawlError');
    expect(err.code).toBe('CRAWL_ERROR');
    expect(err.context).toEqual({ url: 'http://example.com' });
  });

  it('ExtractionError has correct name', () => {
    expect(new ExtractionError('fail').name).toBe('ExtractionError');
  });

  it('LLMError has correct name', () => {
    expect(new LLMError('rate limit').name).toBe('LLMError');
  });

  it('ConfigError has correct name', () => {
    expect(new ConfigError('missing key').name).toBe('ConfigError');
  });

  it('StorageError has correct name', () => {
    expect(new StorageError('connection lost').name).toBe('StorageError');
  });
});

describe('new error types', () => {
  it('QueueError has correct name, code, and retryable=false', () => {
    const err = new QueueError('queue failure');
    expect(err.name).toBe('QueueError');
    expect(err.code).toBe('QUEUE_ERROR');
    expect(err.retryable).toBe(false);
  });

  it('TimeoutError has correct name, code, and retryable=true by default', () => {
    const err = new TimeoutError('timed out');
    expect(err.name).toBe('TimeoutError');
    expect(err.code).toBe('TIMEOUT_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('TimeoutError retryable can be overridden to false', () => {
    const err = new TimeoutError('timed out', { retryable: false });
    expect(err.retryable).toBe(false);
  });

  it('RateLimitError has correct name, code, and retryable=true by default', () => {
    const err = new RateLimitError('rate limited');
    expect(err.name).toBe('RateLimitError');
    expect(err.code).toBe('RATE_LIMIT_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('RateLimitError supports retryAfterMs property', () => {
    const err = new RateLimitError('rate limited', { retryAfterMs: 5000 });
    expect(err.retryAfterMs).toBe(5000);
  });

  it('RateLimitError retryAfterMs is undefined when not provided', () => {
    const err = new RateLimitError('rate limited');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('NetworkError has correct name, code, and retryable=true by default', () => {
    const err = new NetworkError('network failure');
    expect(err.name).toBe('NetworkError');
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('StateError has correct name, code, and retryable=false', () => {
    const err = new StateError('invalid state');
    expect(err.name).toBe('StateError');
    expect(err.code).toBe('STATE_ERROR');
    expect(err.retryable).toBe(false);
  });
});
