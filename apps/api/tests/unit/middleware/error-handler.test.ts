import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));
vi.mock('@accidentally-awesome-labs/spatula-shared', async () => {
  const actual = await vi.importActual<typeof import('@accidentally-awesome-labs/spatula-shared')>(
    '@accidentally-awesome-labs/spatula-shared',
  );
  return { ...actual, captureException: mockCaptureException };
});

import {
  errorHandler,
  NotFoundError,
  ConflictError,
} from '../../../src/middleware/error-handler.js';
import {
  ErrorCode,
  JobNotFoundError,
  EntityNotFoundError,
  TenantNotFoundError,
  AuthInsufficientScopeError,
  AuthMissingTokenError,
  ValidationSchemaError,
  ValidationParamsError,
  RateLimitExceededError,
  InternalError,
  InternalTimeoutError,
  VersionMismatchError,
  // legacy subclasses still must map correctly via mapErrorToStatus fallthrough
  ValidationError,
  StorageError,
  QueueError,
  TimeoutError,
  RateLimitError,
  NetworkError,
  StateError,
} from '@accidentally-awesome-labs/spatula-shared';

function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe('errorHandler middleware envelope', () => {
  it('maps JobNotFoundError to 404 with JOB.NOT_FOUND code and details.jobId', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new JobNotFoundError('abc');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.JOB_NOT_FOUND); // 'JOB.NOT_FOUND'
    expect(body.error.details).toBeDefined();
    expect(body.error.details.jobId).toBe('abc');
    expect(body.error.requestId).toBeDefined();
  });

  it('maps a generic Error to 500 INTERNAL.ERROR with no details (no leak)', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('boom');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.INTERNAL_ERROR); // 'INTERNAL.ERROR'
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.details).toBeUndefined();
  });

  it('maps ValidationSchemaError with details.issues to 400 VALIDATION.SCHEMA', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new ValidationSchemaError('field foo bad', {
        context: { field: 'foo', issues: [{ path: ['foo'], message: 'required' }] },
      });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.VALIDATION_SCHEMA);
    expect(body.error.details).toBeDefined();
    expect(body.error.details.field).toBe('foo');
    expect(body.error.details.issues).toEqual([{ path: ['foo'], message: 'required' }]);
  });

  it('maps EntityNotFoundError to 404 ENTITY.NOT_FOUND with entityId details', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new EntityNotFoundError('e1');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ENTITY.NOT_FOUND');
    expect(body.error.details.entityId).toBe('e1');
  });

  it('maps TenantNotFoundError to 404 TENANT.NOT_FOUND with tenantId details', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new TenantNotFoundError('t1');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT.NOT_FOUND');
    expect(body.error.details.tenantId).toBe('t1');
  });

  it('maps AuthInsufficientScopeError to 403 AUTH.INSUFFICIENT_SCOPE', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AuthInsufficientScopeError('need admin', {
        context: { requiredScope: 'admin' },
      });
    });
    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH.INSUFFICIENT_SCOPE');
    expect(body.error.details.requiredScope).toBe('admin');
  });

  it('maps AuthMissingTokenError to 401 AUTH.MISSING_TOKEN', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new AuthMissingTokenError('no token');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH.MISSING_TOKEN');
  });

  it('maps ValidationParamsError to 400 VALIDATION.PARAMS', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new ValidationParamsError('bad query', {
        context: { field: 'limit', value: '0' },
      });
    });
    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION.PARAMS');
    expect(body.error.details.field).toBe('limit');
  });

  it('maps RateLimitExceededError to 429 RATE_LIMIT.EXCEEDED with limit/resetAt details', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new RateLimitExceededError('throttled', { limit: 300, resetAt: 1234567890 });
    });
    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMIT.EXCEEDED');
    expect(body.error.details.limit).toBe(300);
    expect(body.error.details.resetAt).toBe(1234567890);
  });

  it('maps VersionMismatchError to 426 (Upgrade Required)', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new VersionMismatchError('client too old');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body.error.code).toBe('VERSION.MISMATCH');
  });

  it('maps InternalError to 500 INTERNAL.ERROR with no details leak (5xx scrubbed)', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InternalError('db died', { context: { secret: 'must-not-leak' } });
    });
    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL.ERROR');
    expect(body.error.message).toBe('Internal server error');
    // 5xx responses MUST NOT leak details — error-handler filters them on status>=500.
    expect(body.error.details).toBeUndefined();
  });

  it('maps InternalTimeoutError to 504 INTERNAL.TIMEOUT', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new InternalTimeoutError('upstream slow');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL.TIMEOUT');
  });

  it('legacy NotFoundError (from error-handler.ts) maps to JOB.NOT_FOUND', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new NotFoundError('Job', 'job-123');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('JOB.NOT_FOUND');
  });

  it('legacy ConflictError (from error-handler.ts) maps to JOB.CONFLICT', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new ConflictError('already exists');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('JOB.CONFLICT');
  });
});

describe('errorHandler middleware — legacy SpatulaError fallthrough', () => {
  // Legacy subclasses retain their original flat code strings. The
  // mapErrorToStatus fallthrough switch ensures they still map to the right
  // HTTP status while routes migrate to the new DOMAIN.CODE subclasses.

  it('legacy ValidationError still maps to 400', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new ValidationError('bad input');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR'); // legacy flat code
  });

  it('legacy StorageError still maps to 500 with scrubbed message', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new StorageError('db down');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('STORAGE_ERROR'); // legacy flat code
    expect(body.error.message).toBe('Internal server error');
  });

  it('legacy QueueError → 503', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new QueueError('queue unavailable');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(503);
  });

  it('legacy TimeoutError → 504', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new TimeoutError('timed out');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(504);
  });

  it('legacy RateLimitError → 429', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new RateLimitError('too many');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(429);
  });

  it('legacy NetworkError → 502', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new NetworkError('upstream unavailable');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(502);
  });

  it('legacy StateError → 409', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new StateError('invalid');
    });
    const res = await app.request('/test');
    expect(res.status).toBe(409);
  });
});

describe('errorHandler middleware — requestId + Sentry behavior', () => {
  it('includes requestId in error response', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('fail');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error.requestId).toBeDefined();
    expect(typeof body.error.requestId).toBe('string');
  });

  it('calls captureException for 5xx errors', async () => {
    mockCaptureException.mockClear();
    const app = createTestApp();
    app.get('/test', () => {
      throw new StorageError('db crashed');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('does NOT call captureException for 4xx errors', async () => {
    mockCaptureException.mockClear();
    const app = createTestApp();
    app.get('/test', () => {
      throw new ValidationSchemaError('bad request');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
