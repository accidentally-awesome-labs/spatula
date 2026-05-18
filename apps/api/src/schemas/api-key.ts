import { z } from '@hono/zod-openapi';
import { AUTH_SCOPES } from '@spatula/shared';

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(255).openapi({ example: 'Production Key' }),
  scopes: z
    .array(z.enum(AUTH_SCOPES))
    .optional()
    .openapi({ example: ['jobs:read', 'jobs:write'] }),
  expiresAt: z.string().datetime().optional().openapi({
    example: '2027-01-01T00:00:00Z',
    description: 'ISO 8601 expiration date (optional)',
  }),
});

export const apiKeyResponseSchema = z
  .object({
    id: z.string().uuid(),
    keyPrefix: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('ApiKey');

export const apiKeyCreatedResponseSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().openapi({
      description: 'The raw API key. This is the only time it will be shown.',
      example: 'sk_live_abc123...',
    }),
    keyPrefix: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('ApiKeyCreated');
