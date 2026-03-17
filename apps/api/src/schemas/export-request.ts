import { z } from 'zod';

export const exportRequestSchema = z.object({
  format: z.enum(['json', 'csv']),
  includeProvenance: z.boolean().default(false),
});

export type ExportRequestParams = z.infer<typeof exportRequestSchema>;
