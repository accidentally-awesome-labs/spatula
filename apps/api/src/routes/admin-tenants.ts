import { Hono } from 'hono';
import { ValidationError } from '@spatula/shared';
import { BILLING_TIERS } from '@spatula/shared';
import type { AppEnv } from '../types.js';

const VALID_PLANS = Object.keys(BILLING_TIERS);
const MIN_RETENTION_DAYS = 7;
const RETENTION_FIELDS = ['completedJobsDays', 'failedJobsDays', 'rawPagesDays', 'exportsDays'] as const;

export function adminTenantRoutes() {
  const app = new Hono<AppEnv>();

  // GET / — list all tenants with pagination, plan filter, and user count
  app.get('/', async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Tenant repo not configured' } }, 503);

    const plan = c.req.query('plan');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

    const [tenantList, total] = await Promise.all([
      deps.tenantRepo.findAll({ plan, limit, offset }),
      deps.tenantRepo.countAll({ plan }),
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
        plan: t.plan,
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
    if (!deps.tenantRepo) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Tenant repo not configured' } }, 503);

    const tenant = await deps.tenantRepo.findById(id);
    if (!tenant) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);

    const [users, usage, recentJobs] = await Promise.all([
      deps.userTenantRepo?.findByTenantId(id) ?? [],
      deps.usageRecordRepo
        ? deps.usageRecordRepo.aggregateByTenant(
            id,
            new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1),
          )
        : [],
      deps.jobRepo.findByTenant(id, { limit: 5 }),
    ]);

    const usageMap: Record<string, number> = {};
    for (const u of usage) {
      usageMap[u.dimension] = u.total;
    }

    return c.json({
      data: {
        ...(tenant as any),
        users: users.map((u: any) => ({ userId: u.userId, role: u.role })),
        usage: usageMap,
        recentJobs: recentJobs.map((j: any) => ({
          id: j.id, name: j.name, status: j.status, createdAt: j.createdAt,
        })),
      },
    });
  });

  // PATCH /:id — update plan, config (status, retention, quotas)
  app.patch('/:id', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    if (!deps.tenantRepo) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Tenant repo not configured' } }, 503);

    const body = await c.req.json();
    const auth = c.get('auth');
    const actorId = auth?.userId ?? 'system';

    // Validate plan if provided
    if (body.plan !== undefined) {
      if (!VALID_PLANS.includes(body.plan)) {
        throw new ValidationError(`Invalid plan: ${body.plan}. Must be one of: ${VALID_PLANS.join(', ')}`);
      }
    }

    // Validate retention config if provided
    if (body.config?.retention) {
      for (const field of RETENTION_FIELDS) {
        const value = body.config.retention[field];
        if (value !== undefined && (typeof value !== 'number' || value < MIN_RETENTION_DAYS)) {
          throw new ValidationError(
            `Retention field "${field}" must be a number >= ${MIN_RETENTION_DAYS}`,
          );
        }
      }
    }

    const existing = await deps.tenantRepo.findById(id);
    if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);

    if (body.plan !== undefined) {
      await deps.tenantRepo.updatePlan(id, body.plan, body.stripeCustomerId);
      deps.auditLogger?.log({
        tenantId: id, actorId, actorType: 'user',
        action: 'admin.tenant.plan_change', resourceType: 'tenant', resourceId: id,
        metadata: { oldPlan: (existing as any).plan, newPlan: body.plan },
      });
    }

    if (body.config !== undefined) {
      const existingConfig = ((existing as any).config ?? {}) as Record<string, unknown>;
      const mergedConfig = { ...existingConfig, ...body.config };
      if (body.config.retention) {
        mergedConfig.retention = {
          ...(existingConfig.retention as Record<string, unknown> ?? {}),
          ...body.config.retention,
        };
      }
      await deps.tenantRepo.update(id, { config: mergedConfig });
      deps.auditLogger?.log({
        tenantId: id, actorId, actorType: 'user',
        action: 'admin.tenant.config_update', resourceType: 'tenant', resourceId: id,
        metadata: { changes: body.config },
      });
    }

    const updated = await deps.tenantRepo.findById(id);
    return c.json({ data: updated });
  });

  return app;
}
