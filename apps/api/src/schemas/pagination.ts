import { z } from '@hono/zod-openapi';

/**
 * Pagination params (Phase 16 plan 16-1).
 *
 * Cursor pagination is CANONICAL at v1. Offset (`offset`, `page`) is
 * DEPRECATED — both still accepted, but routes that receive offset emit
 * `Deprecation` + `Sunset` + `Link` headers (RFC 8594). Sunset target: v2.0.
 */
export const paginationSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((v) => Math.min(v, 500)),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .openapi({
      deprecated: true,
      description: 'DEPRECATED: use cursor pagination. Removal target v2.0.',
    }),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({
      deprecated: true,
      description: 'DEPRECATED: use cursor pagination. Removal target v2.0.',
    }),
  cursor: z.string().optional().openapi({
    description: 'Opaque cursor for keyset pagination. CANONICAL — treat as opaque, do not parse.',
    example: 'eyJpZCI6Ijk4NzYifQ',
  }),
  since: z.string().datetime().optional().openapi({
    description:
      'ISO 8601 timestamp for incremental fetch. Returns records updated after this time.',
    example: '2026-03-21T14:32:00Z',
  }),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

/**
 * Canonical cursor-based response envelope (v1 frozen).
 *
 * Shape: `{ data: T[], nextCursor?: string, hasMore: boolean }`. No `total`
 * count — cursor pagination is fundamentally streaming/incremental.
 */
export function cursorEnvelopeSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    nextCursor: z
      .string()
      .optional()
      .openapi({ description: 'Opaque cursor for the next page. Treat as opaque — do not parse.' }),
    hasMore: z.boolean(),
  });
}

/**
 * @deprecated Offset-based response envelope. Removal target v2.0.
 *
 * Shape: `{ data: T[], total, page, limit, hasMore }`. Mirrors the legacy
 * envelope that existing routes emit; new routes should use
 * `cursorEnvelopeSchema` and SDK consumers should adopt cursor pagination.
 *
 * Routes that emit this envelope MUST also call `applyDeprecationHeaders(c)`
 * on the response to write `Deprecation` + `Sunset` + `Link` headers.
 */
export function offsetEnvelopeSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      data: z.array(itemSchema),
      total: z.number(),
      page: z.number(),
      limit: z.number(),
      hasMore: z.boolean(),
    })
    .openapi({ deprecated: true });
}

/**
 * @deprecated Legacy mixed-shape envelope (carries both `total` + `nextCursor`).
 * DO NOT use in new code. Use `cursorEnvelopeSchema` or `offsetEnvelopeSchema`.
 * Kept here as a re-export to preserve backward compatibility for callers that
 * still reference it during the Phase 16 sweep.
 */
export const paginationEnvelopeSchema = z.object({
  total: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
});
