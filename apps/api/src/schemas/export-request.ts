import { z } from '@hono/zod-openapi';

export const exportRequestSchema = z.object({
  format: z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite']),
  includeProvenance: z.boolean().default(false),
});

export type ExportRequestParams = z.infer<typeof exportRequestSchema>;
