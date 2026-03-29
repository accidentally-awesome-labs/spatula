import { z } from '@hono/zod-openapi';

export const paginationSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().optional().openapi({
    description: 'Opaque cursor for keyset pagination. Mutually exclusive with offset.',
    example: 'eyJpZCI6Ijk4NzYifQ',
  }),
  since: z.string().datetime().optional().openapi({
    description: 'ISO 8601 timestamp for incremental fetch. Returns records updated after this time.',
    example: '2026-03-21T14:32:00Z',
  }),
});

export type PaginationParams = z.infer<typeof paginationSchema>;
