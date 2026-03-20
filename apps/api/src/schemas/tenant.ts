import { z } from '@hono/zod-openapi';

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  config: z.record(z.unknown()).optional(),
});

export type CreateTenantBody = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    config: z.record(z.unknown()).optional(),
  })
  .refine((data) => data.name !== undefined || data.config !== undefined, {
    message: 'At least one of name or config must be provided',
  });

export type UpdateTenantBody = z.infer<typeof updateTenantSchema>;
