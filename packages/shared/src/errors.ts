export interface SpatulaErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
  retryable?: boolean;
}

export class SpatulaError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(message: string, code: string, options?: SpatulaErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = 'SpatulaError';
    this.code = code;
    this.context = options?.context;
    this.retryable = options?.retryable ?? false;
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

export class QueueError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'QUEUE_ERROR', options);
    this.name = 'QueueError';
  }
}

export class TimeoutError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'TIMEOUT_ERROR', { ...options, retryable: options?.retryable ?? true });
    this.name = 'TimeoutError';
  }
}

export class RateLimitError extends SpatulaError {
  readonly retryAfterMs?: number;

  constructor(message: string, options?: SpatulaErrorOptions & { retryAfterMs?: number }) {
    super(message, 'RATE_LIMIT_ERROR', { ...options, retryable: options?.retryable ?? true });
    this.name = 'RateLimitError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class NetworkError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'NETWORK_ERROR', { ...options, retryable: options?.retryable ?? true });
    this.name = 'NetworkError';
  }
}

export class StateError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'STATE_ERROR', options);
    this.name = 'StateError';
  }
}

export class AuthError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'AUTH_ERROR', options);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'FORBIDDEN', options);
    this.name = 'ForbiddenError';
  }
}
