import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue(vi.fn()),
  jwtVerify: vi.fn(),
}));

import { JwtAuthProvider } from '../../../src/auth/jwt-provider.js';
import { jwtVerify } from 'jose';

const mockedJwtVerify = vi.mocked(jwtVerify);

async function createMockRequest(headers: Record<string, string> = {}) {
  const app = new Hono();
  let capturedReq: any;
  app.get('/test', (c) => { capturedReq = c.req; return c.text('ok'); });
  await app.request('/test', { headers });
  return capturedReq;
}

describe('JwtAuthProvider', () => {
  let provider: JwtAuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new JwtAuthProvider({
      issuer: 'https://auth.spatula.dev',
      audience: 'https://api.spatula.dev',
      jwksUrl: 'https://auth.spatula.dev/.well-known/jwks.json',
    });
  });

  it('authenticates a valid JWT and extracts claims', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: {
        sub: 'user-123', tenant_id: 'tenant-456',
        scopes: ['jobs:read', 'jobs:write'],
      },
      protectedHeader: { alg: 'RS256' },
    } as any);
    const req = await createMockRequest({ authorization: 'Bearer eyJ.test.sig' });
    const result = await provider.authenticate(req);
    expect(result.tenantId).toBe(''); // Resolved later by auth middleware
    expect(result.userId).toBe('user-123');
    expect(result.scopes).toEqual(['jobs:read', 'jobs:write']);
    expect(result.strategy).toBe('jwt');
  });

  it('throws when Authorization header is missing', async () => {
    const req = await createMockRequest({});
    await expect(provider.authenticate(req)).rejects.toThrow('Authorization header is required');
  });

  it('throws when JWT is invalid', async () => {
    mockedJwtVerify.mockRejectedValue(new Error('invalid signature'));
    const req = await createMockRequest({ authorization: 'Bearer bad.jwt.token' });
    await expect(provider.authenticate(req)).rejects.toThrow('Invalid or expired token');
  });

  it('returns empty tenantId when tenant_id claim is missing (resolved by middleware)', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: { sub: 'user-123', scopes: ['jobs:read'] },
      protectedHeader: { alg: 'RS256' },
    } as any);
    const req = await createMockRequest({ authorization: 'Bearer eyJ.test.sig' });
    const result = await provider.authenticate(req);
    expect(result.tenantId).toBe('');
    expect(result.strategy).toBe('jwt');
  });

  it('defaults scopes to empty array when missing', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: { sub: 'user-123', tenant_id: 'tenant-456' },
      protectedHeader: { alg: 'RS256' },
    } as any);
    const req = await createMockRequest({ authorization: 'Bearer eyJ.test.sig' });
    const result = await provider.authenticate(req);
    expect(result.scopes).toEqual([]);
    expect(result.strategy).toBe('jwt');
  });
});
