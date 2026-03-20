import { z } from '@hono/zod-openapi';

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  config: z.record(z.unknown()).optional(),
});

export type CreateTenantBody = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.unknown()).optional(),
});

export type UpdateTenantBody = z.infer<typeof updateTenantSchema>;
