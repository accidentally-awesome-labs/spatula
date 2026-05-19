/**
 * Frozen v1 auth-scope enum.
 *
 * Mirrors `AUTH_SCOPES` in `@spatula/shared/auth/types.ts`. Frozen at v1;
 * additive-only in 1.x. Adding a scope is non-breaking; renaming or removing
 * one is breaking and requires v2.
 */
export const Scope = {
  JOBS_READ: 'jobs:read',
  JOBS_WRITE: 'jobs:write',
  EXPORTS_READ: 'exports:read',
  EXPORTS_WRITE: 'exports:write',
  ACTIONS_READ: 'actions:read',
  ACTIONS_WRITE: 'actions:write',
  TENANTS_ADMIN: 'tenants:admin',
  KEYS_MANAGE: 'keys:manage',
  ADMIN: 'admin',
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];
