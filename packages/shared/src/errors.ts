import { ErrorCode } from './error-codes.js';

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

// ---------------------------------------------------------------------------
// Legacy subclasses (flat code strings). Kept for backward compatibility
// so internal callers continue compiling while
// individual routes migrate to the new DOMAIN.CODE subclasses below.
//
// These are @deprecated as a class — they will be removed in v2. New code
// should use the domain-specific subclasses (JobNotFoundError, etc.).
// ---------------------------------------------------------------------------

/** @deprecated Use the domain-specific subclass (`ValidationSchemaError`, `ValidationParamsError`). Removed in v2. */
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

/** @deprecated Use the domain-specific subclass (`ExtractionFailedError`, `ExtractionQuotaExceededError`). Removed in v2. */
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

/** @deprecated Use `InternalQueueError`. Removed in v2. */
export class QueueError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'QUEUE_ERROR', options);
    this.name = 'QueueError';
  }
}

/** @deprecated Use `InternalTimeoutError`. Removed in v2. */
export class TimeoutError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'TIMEOUT_ERROR', { ...options, retryable: options?.retryable ?? true });
    this.name = 'TimeoutError';
  }
}

/** @deprecated Use `RateLimitExceededError`. Removed in v2. */
export class RateLimitError extends SpatulaError {
  readonly retryAfterMs?: number;

  constructor(message: string, options?: SpatulaErrorOptions & { retryAfterMs?: number }) {
    super(message, 'RATE_LIMIT_ERROR', { ...options, retryable: options?.retryable ?? true });
    this.name = 'RateLimitError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** @deprecated Use `InternalNetworkError`. Removed in v2. */
export class NetworkError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'NETWORK_ERROR', { ...options, retryable: options?.retryable ?? true });
    this.name = 'NetworkError';
  }
}

/** @deprecated Use `JobInvalidStateError`. Removed in v2. */
export class StateError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'STATE_ERROR', options);
    this.name = 'StateError';
  }
}

/** @deprecated Use `AuthInvalidTokenError` or `AuthMissingTokenError`. Removed in v2. */
export class AuthError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'AUTH_ERROR', options);
    this.name = 'AuthError';
  }
}

/** @deprecated Use `AuthInsufficientScopeError`. Removed in v2. */
export class ForbiddenError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'FORBIDDEN', options);
    this.name = 'ForbiddenError';
  }
}

// ---------------------------------------------------------------------------
// New v1 typed subclasses — keyed to the frozen `ErrorCode` enum.
//
// Naming: `<Subject><Failure>Error`. Each constructor accepts the minimum
// identifying context (e.g., `jobId`) and merges any additional caller
// `context` into the resulting `SpatulaError.context` (the `details` payload
// that the error-handler middleware passes through to the JSON envelope).
// ---------------------------------------------------------------------------

// JOB.*

export class JobNotFoundError extends SpatulaError {
  constructor(jobId: string, options?: SpatulaErrorOptions) {
    super(`Job ${jobId} not found`, ErrorCode.JOB_NOT_FOUND, {
      ...options,
      context: { jobId, ...options?.context },
    });
    this.name = 'JobNotFoundError';
  }
}

export class JobConflictError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.JOB_CONFLICT, options);
    this.name = 'JobConflictError';
  }
}

export class JobInvalidStateError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.JOB_INVALID_STATE, options);
    this.name = 'JobInvalidStateError';
  }
}

// EXTRACTION.*

export class ExtractionQuotaExceededError extends SpatulaError {
  constructor(
    message: string,
    options?: SpatulaErrorOptions & { limit?: number; remaining?: number; resetAt?: number },
  ) {
    const { limit, remaining, resetAt, context, ...rest } = options ?? {};
    super(message, ErrorCode.EXTRACTION_QUOTA_EXCEEDED, {
      ...rest,
      retryable: rest.retryable ?? true,
      context: {
        ...(limit !== undefined && { limit }),
        ...(remaining !== undefined && { remaining }),
        ...(resetAt !== undefined && { resetAt }),
        ...context,
      },
    });
    this.name = 'ExtractionQuotaExceededError';
  }
}

export class ExtractionFailedError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.EXTRACTION_FAILED, options);
    this.name = 'ExtractionFailedError';
  }
}

// SCHEMA.*

export class SchemaNotFoundError extends SpatulaError {
  constructor(idOrJobId: string, options?: SpatulaErrorOptions) {
    super(`Schema ${idOrJobId} not found`, ErrorCode.SCHEMA_NOT_FOUND, {
      ...options,
      context: { schemaRef: idOrJobId, ...options?.context },
    });
    this.name = 'SchemaNotFoundError';
  }
}

export class SchemaVersionConflictError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.SCHEMA_VERSION_CONFLICT, options);
    this.name = 'SchemaVersionConflictError';
  }
}

// ENTITY.*

export class EntityNotFoundError extends SpatulaError {
  constructor(entityId: string, options?: SpatulaErrorOptions) {
    super(`Entity ${entityId} not found`, ErrorCode.ENTITY_NOT_FOUND, {
      ...options,
      context: { entityId, ...options?.context },
    });
    this.name = 'EntityNotFoundError';
  }
}

// EXPORT.*

export class ExportNotFoundError extends SpatulaError {
  constructor(exportId: string, options?: SpatulaErrorOptions) {
    super(`Export ${exportId} not found`, ErrorCode.EXPORT_NOT_FOUND, {
      ...options,
      context: { exportId, ...options?.context },
    });
    this.name = 'ExportNotFoundError';
  }
}

export class ExportFailedError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.EXPORT_FAILED, options);
    this.name = 'ExportFailedError';
  }
}

// AUTH.*

export class AuthInvalidTokenError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.AUTH_INVALID_TOKEN, options);
    this.name = 'AuthInvalidTokenError';
  }
}

export class AuthMissingTokenError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.AUTH_MISSING_TOKEN, options);
    this.name = 'AuthMissingTokenError';
  }
}

export class AuthInsufficientScopeError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.AUTH_INSUFFICIENT_SCOPE, options);
    this.name = 'AuthInsufficientScopeError';
  }
}

// TENANT.*

export class TenantNotFoundError extends SpatulaError {
  constructor(tenantId: string, options?: SpatulaErrorOptions) {
    super(`Tenant ${tenantId} not found`, ErrorCode.TENANT_NOT_FOUND, {
      ...options,
      context: { tenantId, ...options?.context },
    });
    this.name = 'TenantNotFoundError';
  }
}

// RATE_LIMIT.* / QUOTA.*

export class RateLimitExceededError extends SpatulaError {
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    options?: SpatulaErrorOptions & { limit?: number; resetAt?: number; retryAfterMs?: number },
  ) {
    const { limit, resetAt, retryAfterMs, context, ...rest } = options ?? {};
    super(message, ErrorCode.RATE_LIMIT_EXCEEDED, {
      ...rest,
      retryable: rest.retryable ?? true,
      context: {
        ...(limit !== undefined && { limit }),
        ...(resetAt !== undefined && { resetAt }),
        ...context,
      },
    });
    this.name = 'RateLimitExceededError';
    this.retryAfterMs = retryAfterMs;
  }
}

// `QuotaExceededError` lives in `./auth/quotas.ts` (pre-existing class, updated
// to use `ErrorCode.QUOTA_EXCEEDED`). It is re-exported via the
// barrel from `./auth/index.ts` so callers can `import { QuotaExceededError } from '@spatula/shared'`.

// VERSION.*

export class VersionMismatchError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.VERSION_MISMATCH, options);
    this.name = 'VersionMismatchError';
  }
}

// VALIDATION.*

export class ValidationSchemaError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.VALIDATION_SCHEMA, options);
    this.name = 'ValidationSchemaError';
  }
}

export class ValidationParamsError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.VALIDATION_PARAMS, options);
    this.name = 'ValidationParamsError';
  }
}

// IDEMPOTENCY.*

export class IdempotencyKeyConflictError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.IDEMPOTENCY_KEY_CONFLICT, options);
    this.name = 'IdempotencyKeyConflictError';
  }
}

// WEBHOOK.*

export class WebhookSignatureInvalidError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.WEBHOOK_SIGNATURE_INVALID, options);
    this.name = 'WebhookSignatureInvalidError';
  }
}

// INTERNAL.*

export class InternalError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.INTERNAL_ERROR, options);
    this.name = 'InternalError';
  }
}

export class InternalTimeoutError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.INTERNAL_TIMEOUT, {
      ...options,
      retryable: options?.retryable ?? true,
    });
    this.name = 'InternalTimeoutError';
  }
}

export class InternalQueueError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.INTERNAL_QUEUE, options);
    this.name = 'InternalQueueError';
  }
}

export class InternalNetworkError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, ErrorCode.INTERNAL_NETWORK, {
      ...options,
      retryable: options?.retryable ?? true,
    });
    this.name = 'InternalNetworkError';
  }
}
