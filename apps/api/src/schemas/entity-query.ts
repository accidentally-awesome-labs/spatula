import { z } from '@hono/zod-openapi';
import { paginationSchema } from './pagination.js';

export const entityQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
});

export type EntityQueryParams = z.infer<typeof entityQuerySchema>;
