import type { HonoRequest } from 'hono';

export interface AuthResult {
  tenantId: string;
  userId: string;
  scopes: string[];
  strategy: 'none' | 'api-key' | 'jwt';
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
