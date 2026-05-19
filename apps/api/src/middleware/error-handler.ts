import type { ErrorHandler } from 'hono';
import {
  SpatulaError,
  ErrorCode,
  STATUS_MAP,
  createLogger,
  captureException,
  JobConflictError,
} from '@spatula/shared';

const logger = createLogger('api:error-handler');

/**
 * Legacy `NotFoundError` re-export. Many in-flight routes still import this
 * directly via `from './middleware/error-handler.js'`. Internally it now
 * extends `JobNotFoundError` for generic "Job"-resource cases and falls back
 * to a SpatulaError(ErrorCode.JOB_NOT_FOUND) for arbitrary `resource` strings.
 *
 * @deprecated Use the domain-specific subclass from `@spatula/shared`
 * (`JobNotFoundError`, `EntityNotFoundError`, etc.). Removed in v2.
 */
export class NotFoundError extends SpatulaError {
  constructor(resource: string, id: string) {
    // Pick the domain code by resource where possible; fall back to JOB.NOT_FOUND
    // for arbitrary resources so the envelope still emits a valid frozen-enum
    // code rather than a legacy flat string.
    const code = ((): ErrorCode => {
      const normalized = resource.toLowerCase();
      if (normalized === 'job') return ErrorCode.JOB_NOT_FOUND;
      if (normalized === 'entity') return ErrorCode.ENTITY_NOT_FOUND;
      if (normalized === 'export' || normalized === 'export content')
        return ErrorCode.EXPORT_NOT_FOUND;
      if (normalized.startsWith('schema')) return ErrorCode.SCHEMA_NOT_FOUND;
      if (normalized === 'tenant') return ErrorCode.TENANT_NOT_FOUND;
      // Fall through: still emits a 404 via STATUS_MAP[JOB.NOT_FOUND].
      return ErrorCode.JOB_NOT_FOUND;
    })();
    super(`${resource} ${id} not found`, code, {
      context: { resource, id },
    });
    this.name = 'NotFoundError';
  }
}

/**
 * @deprecated Use `JobConflictError` (or another domain-specific `*ConflictError`)
 * from `@spatula/shared`. Kept as a re-export for in-flight routes during the
 * Phase 16 sweep. Removed in v2.
 */
export class ConflictError extends JobConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

function mapErrorToStatus(error: unknown): number {
  if (error instanceof SpatulaError) {
    // Primary path: the new frozen STATUS_MAP keyed by ErrorCode values.
    const mapped = STATUS_MAP[error.code as keyof typeof STATUS_MAP];
    if (mapped !== undefined) return mapped;

    // Legacy fallthrough: support any SpatulaError subclass that still emits a
    // pre-Phase-16 flat code (CRAWL_ERROR, EXTRACTION_ERROR, LLM_ERROR, etc.)
    // until those callers migrate to a domain-specific subclass.
    switch (error.code) {
      case 'VALIDATION_ERROR':
        return 400;
      case 'AUTH_ERROR':
        return 401;
      case 'FORBIDDEN':
        return 403;
      case 'NOT_FOUND':
        return 404;
      case 'CONFLICT':
        return 409;
      case 'STATE_ERROR':
        return 409;
      case 'QUEUE_ERROR':
        return 503;
      case 'TIMEOUT_ERROR':
        return 504;
      case 'RATE_LIMIT_ERROR':
        return 429;
      case 'QUOTA_EXCEEDED':
        return 429;
      case 'NETWORK_ERROR':
        return 502;
      default:
        return 500;
    }
  }
  return 500;
}

export const errorHandler: ErrorHandler = (error, c) => {
  const status = mapErrorToStatus(error);
  const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID();

  if (status >= 500) {
    logger.error({ err: error, requestId, path: c.req.path }, 'unhandled error');
    captureException(error, { requestId, path: c.req.path });
  } else {
    logger.warn(
      {
        code: (error as SpatulaError).code,
        requestId,
        path: c.req.path,
      },
      error.message,
    );
  }

  const code = error instanceof SpatulaError ? error.code : ErrorCode.INTERNAL_ERROR;
  const message = status >= 500 ? 'Internal server error' : error.message;

  // `details` flows from `SpatulaError.context` when present, exposing extra
  // structured information (jobId, limit, resetAt, issues, …) on 4xx errors.
  // 5xx errors omit `details` to avoid leaking internal state.
  const details =
    status < 500 &&
    error instanceof SpatulaError &&
    error.context &&
    Object.keys(error.context).length > 0
      ? error.context
      : undefined;

  return c.json(
    {
      error: {
        code,
        message,
        requestId,
        ...(details ? { details } : {}),
      },
    },
    status as any,
  );
};
