import { z } from '@hono/zod-openapi';

export const exportRequestSchema = z.object({
  format: z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite']),
  includeProvenance: z.boolean().default(false),
  minQuality: z.number().min(0).max(1).optional().openapi({
    description: 'Minimum quality score filter (0-1)',
    example: 0.7,
  }),
  fields: z.array(z.string()).optional().openapi({
    description: 'Subset of fields to include in export',
    example: ['name', 'price', 'description'],
  }),
});

export type ExportRequestParams = z.infer<typeof exportRequestSchema>;
