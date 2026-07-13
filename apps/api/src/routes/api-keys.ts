import { randomBytes, createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import {
  createApiKeySchema,
  apiKeyResponseSchema,
  apiKeyCreatedResponseSchema,
  rotateApiKeyRequestSchema,
  apiKeyRotatedResponseSchema,
} from '../schemas/api-key.js';
import {
  errorResponseSchema,
  dataResponse,
  listResponse,
  jsonContent,
} from '../schemas/responses.js';
import {
  AuthInsufficientScopeError,
  DEFAULT_API_KEY_SCOPES,
  ErrorCode,
  InternalError,
  SpatulaError,
  StorageError,
} from '@spatula/shared';

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const random = randomBytes(24).toString('base64url');
  const raw = `sk_live_${random}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}

const createKeyRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['API Keys'],
  summary: 'Create a new API key',
  request: {
    body: {
      content: { 'application/json': { schema: createApiKeySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(
      dataResponse(apiKeyCreatedResponseSchema),
      'API key created (raw key shown once)',
    ),
    400: jsonContent(errorResponseSchema, 'Validation error'),
  },
});

const listKeysRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['API Keys'],
  summary: 'List API keys for tenant',
  responses: {
    200: jsonContent(listResponse(apiKeyResponseSchema), 'List of API keys'),
  },
});

const revokeKeyRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['API Keys'],
  summary: 'Revoke an API key',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({ data: z.object({ id: z.string(), revoked: z.boolean() }) }),
      'API key revoked',
    ),
    404: jsonContent(errorResponseSchema, 'API key not found'),
  },
});

const rotateKeyRoute = createRoute({
  method: 'post',
  path: '/{id}/rotate',
  tags: ['API Keys'],
  summary: 'Rotate an API key (zero-downtime, two-key grace window)',
  description:
    'Creates a new key inheriting the original scopes verbatim. The old key keeps ' +
    'validating until its grace window expires. Default grace = 86400 s (24h); max 604800 s (7d).',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: {
      content: { 'application/json': { schema: rotateApiKeyRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: jsonContent(
      dataResponse(apiKeyRotatedResponseSchema),
      'API key rotated; new raw key shown once',
    ),
    404: jsonContent(errorResponseSchema, 'API key not found'),
    409: jsonContent(errorResponseSchema, 'API key already revoked'),
  },
});

export function apiKeyRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(createKeyRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.apiKeyRepo) throw new InternalError('API key management not configured');
    const tenantId = c.get('tenantId');
    const body = c.req.valid('json');

    const { raw, hash, prefix } = generateApiKey();
    const scopes = body.scopes ?? [...DEFAULT_API_KEY_SCOPES];

    // Prevent privilege escalation: requested scopes must be subset of caller's scopes
    const callerScopes = c.get('auth').scopes;
    if (!callerScopes.includes('admin')) {
      const invalidScopes = scopes.filter((s: string) => !callerScopes.includes(s));
      if (invalidScopes.length > 0) {
        throw new AuthInsufficientScopeError(
          `Cannot grant scopes you don't have: ${invalidScopes.join(', ')}`,
          { context: { invalidScopes } },
        );
      }
    }

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;

    const key = await deps.apiKeyRepo.create({
      tenantId,
      keyHash: hash,
      keyPrefix: prefix,
      name: body.name,
      scopes,
      expiresAt,
    });

    // Audit log
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'api_key.created',
        resourceType: 'api_key',
        resourceId: key.id,
      });
    }

    return c.json(
      {
        data: {
          id: key.id,
          key: raw,
          keyPrefix: key.keyPrefix,
          name: key.name,
          scopes: key.scopes,
          expiresAt: key.expiresAt?.toISOString() ?? null,
          createdAt: key.createdAt.toISOString(),
        },
      },
      201,
    );
  });

  router.openapi(listKeysRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.apiKeyRepo) throw new InternalError('API key management not configured');
    const tenantId = c.get('tenantId');

    const keys = await deps.apiKeyRepo.listByTenant(tenantId);
    return c.json({
      data: keys.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        name: k.name,
        scopes: k.scopes,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdAt: k.createdAt.toISOString(),
      })),
    });
  });

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(revokeKeyRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.apiKeyRepo) throw new InternalError('API key management not configured');
    const tenantId = c.get('tenantId');
    const { id } = c.req.valid('param');

    try {
      await deps.apiKeyRepo.revoke(id, tenantId);
    } catch (error) {
      if (error instanceof StorageError && error.message.includes('not found')) {
        throw new SpatulaError(`API key ${id} not found`, ErrorCode.JOB_NOT_FOUND, {
          context: { resource: 'api_key', apiKeyId: id },
        });
      }
      throw error;
    }

    // Audit log
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'api_key.revoked',
        resourceType: 'api_key',
        resourceId: id,
      });
    }

    return c.json({ data: { id, revoked: true } });
  });

  router.openapi(rotateKeyRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.apiKeyRepo) throw new InternalError('API key management not configured');

    const tenantId = c.get('tenantId');
    const { id } = c.req.valid('param');

    // Body is optional; default graceSeconds to 86400 (24h) and clamp to 0..604800 (7d cap).
    const body = c.req.valid('json');
    const graceSeconds = Math.min(Math.max(body?.graceSeconds ?? 86400, 0), 604800);

    // Generate the new key material — raw key never enters the repository layer.
    const { raw, hash, prefix } = generateApiKey();

    let oldKey: Awaited<ReturnType<typeof deps.apiKeyRepo.rotate>>['oldKey'];
    let newKey: Awaited<ReturnType<typeof deps.apiKeyRepo.rotate>>['newKey'];

    try {
      ({ oldKey, newKey } = await deps.apiKeyRepo.rotate(
        id,
        tenantId,
        { keyHash: hash, keyPrefix: prefix },
        graceSeconds,
      ));
    } catch (error) {
      if (error instanceof StorageError) {
        if (error.message.includes('not found')) {
          throw new SpatulaError(`API key ${id} not found`, ErrorCode.RESOURCE_NOT_FOUND, {
            context: { resource: 'api_key', apiKeyId: id },
          });
        }
        if (error.message.includes('revoked')) {
          throw new SpatulaError(`API key ${id} is already revoked`, ErrorCode.JOB_INVALID_STATE, {
            context: { resource: 'api_key', apiKeyId: id },
          });
        }
      }
      throw error;
    }

    // Emit audit event with both old and new key ids present.
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'api_key.rotated',
        resourceType: 'api_key',
        resourceId: newKey.id,
        metadata: { supersedes: oldKey.id },
      });
    }

    // supersededExpiresAt = oldKey.expiresAt (set by rotate() to graceUntil).
    return c.json(
      {
        data: {
          id: newKey.id,
          key: raw,
          keyPrefix: newKey.keyPrefix,
          scopes: newKey.scopes,
          expiresAt: newKey.expiresAt?.toISOString() ?? null,
          createdAt: newKey.createdAt.toISOString(),
          supersedes: oldKey.id,
          supersededExpiresAt: oldKey.expiresAt!.toISOString(),
        },
      },
      200,
    );
  });

  return router;
}
