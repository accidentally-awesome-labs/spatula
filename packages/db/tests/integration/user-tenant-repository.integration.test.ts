/**
 * Integration tests for UserTenantRepository against real Postgres.
 *
 * Requires: TEST_DATABASE_URL pointing to a Postgres instance with migrations applied.
 * Run: pnpm --filter @spatula/db exec vitest run tests/integration/user-tenant-repository.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDatabasePool, type DatabasePool } from '../../src/connection.js';
import { TenantRepository } from '../../src/repositories/tenant-repository.js';
import { UserTenantRepository } from '../../src/repositories/user-tenant-repository.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://spatula:spatula@localhost:5432/spatula_test';

let dbPool: DatabasePool;
let tenantRepo: TenantRepository;
let repo: UserTenantRepository;

// Track created tenants for cleanup
const createdTenantIds: string[] = [];

beforeAll(() => {
  dbPool = createDatabasePool(TEST_DB_URL);
  tenantRepo = new TenantRepository(dbPool.db);
  repo = new UserTenantRepository(dbPool.db);
});

afterAll(async () => {
  // Cleanup: delete user_tenants first (FK), then tenants
  for (const tid of createdTenantIds) {
    await dbPool.db.execute(sql`DELETE FROM user_tenants WHERE tenant_id = ${tid}`);
    await dbPool.db.execute(sql`DELETE FROM tenants WHERE id = ${tid}::uuid`);
  }
  await dbPool.pool.end();
});

async function createTestTenant(name: string): Promise<string> {
  const tenant = await tenantRepo.create({ name });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

describe('UserTenantRepository (integration)', () => {
  const userId = `test-user-${randomUUID()}`;
  const userId2 = `test-user-${randomUUID()}`;
  let tenantId1: string;
  let tenantId2: string;

  beforeAll(async () => {
    tenantId1 = await createTestTenant('Integration Test Tenant 1');
    tenantId2 = await createTestTenant('Integration Test Tenant 2');
  });

  beforeEach(async () => {
    // Clean user_tenants for our test users between tests
    await dbPool.db.execute(sql`DELETE FROM user_tenants WHERE user_id = ${userId}`);
    await dbPool.db.execute(sql`DELETE FROM user_tenants WHERE user_id = ${userId2}`);
  });

  it('creates and retrieves a user-tenant relationship', async () => {
    await repo.create(userId, tenantId1, 'owner');

    const entries = await repo.findByUserId(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0].tenantId).toBe(tenantId1);
    expect(entries[0].role).toBe('owner');
    expect(entries[0].createdAt).toBeInstanceOf(Date);
  });

  it('supports a user belonging to multiple tenants', async () => {
    await repo.create(userId, tenantId1, 'owner');
    await repo.create(userId, tenantId2, 'member');

    const entries = await repo.findByUserId(userId);
    expect(entries).toHaveLength(2);
    const tenantIds = entries.map((e) => e.tenantId).sort();
    expect(tenantIds).toEqual([tenantId1, tenantId2].sort());
  });

  it('finds all users for a tenant', async () => {
    await repo.create(userId, tenantId1, 'owner');
    await repo.create(userId2, tenantId1, 'member');

    const users = await repo.findByTenantId(tenantId1);
    expect(users).toHaveLength(2);
    const userIds = users.map((u) => u.userId).sort();
    expect(userIds).toEqual([userId, userId2].sort());
  });

  it('onConflictDoNothing handles duplicate insert gracefully', async () => {
    await repo.create(userId, tenantId1, 'owner');
    // Second insert with same PK should NOT throw
    await repo.create(userId, tenantId1, 'owner');

    const entries = await repo.findByUserId(userId);
    expect(entries).toHaveLength(1);
  });

  it('onConflictDoNothing does NOT update role on duplicate', async () => {
    await repo.create(userId, tenantId1, 'member');
    await repo.create(userId, tenantId1, 'admin'); // different role, same PK

    const entries = await repo.findByUserId(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('member'); // original role preserved
  });

  it('partial unique index prevents a user from owning two tenants', async () => {
    await repo.create(userId, tenantId1, 'owner');

    // Direct insert to bypass onConflictDoNothing and hit the unique index
    await expect(
      dbPool.db.execute(
        sql`INSERT INTO user_tenants (user_id, tenant_id, role) VALUES (${userId}, ${tenantId2}::uuid, 'owner')`,
      ),
    ).rejects.toThrow(); // Unique partial index violation
  });

  it('allows a user to be member on multiple tenants (not blocked by owner index)', async () => {
    await repo.create(userId, tenantId1, 'member');
    await repo.create(userId, tenantId2, 'member');

    const entries = await repo.findByUserId(userId);
    expect(entries).toHaveLength(2);
  });

  it('updateRole changes the role', async () => {
    await repo.create(userId, tenantId1, 'member');
    await repo.updateRole(userId, tenantId1, 'admin');

    const entries = await repo.findByUserId(userId);
    expect(entries[0].role).toBe('admin');
  });

  it('remove deletes the relationship', async () => {
    await repo.create(userId, tenantId1, 'owner');
    await repo.remove(userId, tenantId1);

    const entries = await repo.findByUserId(userId);
    expect(entries).toHaveLength(0);
  });

  it('isAdmin returns true for owner and admin, false for member', async () => {
    await repo.create(userId, tenantId1, 'owner');
    expect(await repo.isAdmin(userId, tenantId1)).toBe(true);

    await repo.updateRole(userId, tenantId1, 'admin');
    expect(await repo.isAdmin(userId, tenantId1)).toBe(true);

    await repo.updateRole(userId, tenantId1, 'member');
    expect(await repo.isAdmin(userId, tenantId1)).toBe(false);
  });

  it('FK cascade: deleting a tenant removes its user_tenants entries', async () => {
    const ephemeralTenantId = await createTestTenant('Ephemeral Tenant');
    await repo.create(userId, ephemeralTenantId, 'owner');

    // Verify entry exists
    let entries = await repo.findByUserId(userId);
    expect(entries.some((e) => e.tenantId === ephemeralTenantId)).toBe(true);

    // Delete the tenant — should cascade to user_tenants
    await dbPool.db.execute(sql`DELETE FROM tenants WHERE id = ${ephemeralTenantId}::uuid`);

    // Entry should be gone
    entries = await repo.findByUserId(userId);
    expect(entries.some((e) => e.tenantId === ephemeralTenantId)).toBe(false);

    // Remove from cleanup list since it's already deleted
    const idx = createdTenantIds.indexOf(ephemeralTenantId);
    if (idx >= 0) createdTenantIds.splice(idx, 1);
  });

  it('returns empty array for unknown user', async () => {
    const entries = await repo.findByUserId('completely-unknown-user');
    expect(entries).toHaveLength(0);
  });
});
