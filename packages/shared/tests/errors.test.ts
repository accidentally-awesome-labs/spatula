import { describe, it, expect } from 'vitest';
import {
  SpatulaError,
  ValidationError,
  CrawlError,
  ExtractionError,
  LLMError,
  ConfigError,
  StorageError,
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
