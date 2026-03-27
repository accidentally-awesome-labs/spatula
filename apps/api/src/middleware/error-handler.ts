import type { ErrorHandler } from 'hono';
import { SpatulaError, createLogger, captureException } from '@spatula/shared';

const logger = createLogger('api:error-handler');

export class NotFoundError extends SpatulaError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`, 'NOT_FOUND', {
      context: { resource, id },
    });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends SpatulaError {
  constructor(message: string) {
    super(message, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

function mapErrorToStatus(error: unknown): number {
  if (error instanceof SpatulaError) {
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
      case 'STATE_ERROR':
        return 409;
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
    logger.error(
      { err: error, requestId, path: c.req.path },
      'unhandled error',
    );
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

  const code =
    error instanceof SpatulaError ? error.code : 'INTERNAL_ERROR';
  const message =
    status >= 500 ? 'Internal server error' : error.message;

  return c.json(
    {
      error: {
        code,
        message,
        requestId,
      },
    },
    status as any,
  );
};
