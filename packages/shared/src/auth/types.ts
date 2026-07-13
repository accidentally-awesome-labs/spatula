import type { HonoRequest } from 'hono';

export interface AuthResult {
  tenantId: string;
  userId: string;
  scopes: string[];
  strategy: 'none' | 'api-key' | 'jwt';
  /** Display name from JWT (name or email claim). Used for auto-tenant naming. */
  displayName?: string;
}

export interface AuthProvider {
  authenticate(request: HonoRequest): Promise<AuthResult>;
}

export const AUTH_SCOPES = [
  'jobs:read',
  'jobs:write',
  'exports:read',
  'exports:write',
  'actions:read',
  'actions:write',
  'tenants:admin',
  'keys:manage',
  'admin',
  // Forensic-extractions admin endpoint.
  // NOT in DEFAULT_API_KEY_SCOPES — admin-only, least-privilege.
  'admin:forensic:read',
] as const;

export type AuthScope = (typeof AUTH_SCOPES)[number];

export const DEFAULT_API_KEY_SCOPES: AuthScope[] = [
  'jobs:read',
  'jobs:write',
  'exports:read',
  'exports:write',
  'actions:read',
  'actions:write',
];
