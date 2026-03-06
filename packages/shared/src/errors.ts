export interface SpatulaErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}

export class SpatulaError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, options?: SpatulaErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = 'SpatulaError';
    this.code = code;
    this.context = options?.context;
  }
}

export class ValidationError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'VALIDATION_ERROR', options);
    this.name = 'ValidationError';
  }
}

export class CrawlError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'CRAWL_ERROR', options);
    this.name = 'CrawlError';
  }
}

export class ExtractionError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'EXTRACTION_ERROR', options);
    this.name = 'ExtractionError';
  }
}

export class LLMError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'LLM_ERROR', options);
    this.name = 'LLMError';
  }
}

export class ConfigError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'CONFIG_ERROR', options);
    this.name = 'ConfigError';
  }
}

export class StorageError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'STORAGE_ERROR', options);
    this.name = 'StorageError';
  }
}
