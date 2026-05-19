import { Hono } from 'hono';
import { InternalQueueError, TenantNotFoundError, ValidationParamsError } from '@spatula/shared';
import type { AppEnv } from '../types.js';

const MIN_RETENTION_DAYS = 7;
const RETENTION_FIELDS = [
  'completedJobsDays',
  'failedJobsDays',
  'rawPagesDays',
  'exportsDays',
] as const;

export function adminTenantRoutes() {
  const app = new Hono<AppEnv>();

  // GET / — list all tenants with pagination and user count
  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) throw new InternalQueueError('Tenant repo not configured');

    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    const [tenantList, total] = await Promise.all([
      deps.tenantRepo.findAll({ limit, offset }),
      deps.tenantRepo.countAll(),
    ]);

    // Fetch user counts in parallel for all tenants in this page
    const userCounts = await Promise.all(
      tenantList.map(async (t: any) => {
        if (!deps.userTenantRepo) return 0;
        const users = await deps.userTenantRepo.findByTenantId(t.id);
        return users.length;
      }),
    );

    return c.json({
      data: tenantList.map((t: any, i: number) => ({
        id: t.id,
        name: t.name,
        storageBytesUsed: t.storageBytesUsed,
        userCount: userCounts[i],
        createdAt: t.createdAt,
        config: t.config,
      })),
      pagination: { total, limit, offset },
    });
  });

  // GET /:id — tenant detail with users, usage, recent jobs
  app.get('/:id', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    if (!deps.tenantRepo) throw new InternalQueueError('Tenant repo not configured');

    const tenant = await deps.tenantRepo.findById(id);
    if (!tenant) throw new TenantNotFoundError(id);

    const [users, recentJobs] = await Promise.all([
      deps.userTenantRepo?.findByTenantId(id) ?? [],
      deps.jobRepo.findByTenant(id, { limit: 5 }),
    ]);

    return c.json({
      data: {
        ...(tenant as any),
        users: users.map((u: any) => ({ userId: u.userId, role: u.role })),
        recentJobs: recentJobs.map((j: any) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          createdAt: j.createdAt,
        })),
      },
    });
  });

  // PATCH /:id — update config (status, retention, quotas)
  app.patch('/:id', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    if (!deps.tenantRepo) throw new InternalQueueError('Tenant repo not configured');

    const body = await c.req.json();
    const auth = c.get('auth');
    const actorId = auth?.userId ?? 'system';

    // Validate retention config if provided
    if (body.config?.retention) {
      for (const field of RETENTION_FIELDS) {
        const value = body.config.retention[field];
        if (value !== undefined && (typeof value !== 'number' || value < MIN_RETENTION_DAYS)) {
          throw new ValidationParamsError(
            `Retention field "${field}" must be a number >= ${MIN_RETENTION_DAYS}`,
            { context: { field, value, min: MIN_RETENTION_DAYS } },
          );
        }
      }
    }

    const existing = await deps.tenantRepo.findById(id);
    if (!existing) throw new TenantNotFoundError(id);

    if (body.config !== undefined) {
      const existingConfig = ((existing as any).config ?? {}) as Record<string, unknown>;
      const mergedConfig = { ...existingConfig, ...body.config };
      if (body.config.retention) {
        mergedConfig.retention = {
          ...((existingConfig.retention as Record<string, unknown>) ?? {}),
          ...body.config.retention,
        };
      }
      await deps.tenantRepo.update(id, { config: mergedConfig });
      deps.auditLogger?.log({
        tenantId: id,
        actorId,
        actorType: 'user',
        action: 'admin.tenant.config_update',
        resourceType: 'tenant',
        resourceId: id,
        metadata: { changes: body.config },
      });
    }

    const updated = await deps.tenantRepo.findById(id);
    return c.json({ data: updated });
  });

  return app;
}
