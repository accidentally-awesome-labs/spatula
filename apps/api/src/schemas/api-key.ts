import { z } from '@hono/zod-openapi';
import { AUTH_SCOPES } from '@accidentally-awesome-labs/spatula-shared';

// ── Rotate API Key ────────────────────────────────────────────────────────────

/**
 * Request body for POST /api/v1/api-keys/:id/rotate.
 * graceSeconds defaults to 86400 (24h) in the handler if absent.
 * Range 0..604800 enforced here; server further clamps in the handler.
 */
export const rotateApiKeyRequestSchema = z
  .object({
    graceSeconds: z
      .number()
      .int()
      .min(0)
      // Note: values above 604800 are server-clamped to 604800 in the handler.
      // No schema-level max so callers receive 200 with clamped window rather than 400.
      .optional()
      .openapi({
        example: 86400,
        description:
          'Grace window in seconds (0–604800, server-clamped). Defaults to 86400 (24h). ' +
          'Both the old and new key validate during this window.',
      }),
  })
  .openapi('RotateApiKeyRequest');

/**
 * Response data shape for POST /api/v1/api-keys/:id/rotate.
 * Raw key shown once; supersedes + supersededExpiresAt record lineage.
 */
export const apiKeyRotatedResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ description: 'New key id' }),
    key: z.string().openapi({
      description: 'Raw API key — shown once. Store it immediately.',
      example: 'sk_live_abc123...',
    }),
    keyPrefix: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.string().nullable().openapi({ description: 'New key expiry (null = no expiry)' }),
    createdAt: z.string(),
    supersedes: z
      .string()
      .uuid()
      .openapi({ description: 'Id of the old key this rotation replaced' }),
    supersededExpiresAt: z.string().openapi({
      description: 'When the old key stops validating (grace window end)',
    }),
  })
  .openapi('ApiKeyRotated');

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
