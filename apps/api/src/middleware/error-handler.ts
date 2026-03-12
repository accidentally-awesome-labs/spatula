import type { ErrorHandler } from 'hono';
import { SpatulaError, createLogger } from '@spatula/shared';

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
      case 'NOT_FOUND':
        return 404;
      case 'CONFLICT':
        return 409;
      default:
        return 500;
    }
  }
  return 500;
}

export const errorHandler: ErrorHandler = (error, c) => {
  const status = mapErrorToStatus(error);
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();

  if (status >= 500) {
    logger.error(
      { err: error, requestId, path: c.req.path },
      'unhandled error',
    );
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
    status >= 500 && !(error instanceof SpatulaError)
      ? 'Internal server error'
      : error.message;

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
