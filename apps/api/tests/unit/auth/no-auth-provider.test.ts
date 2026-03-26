import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { NoAuthProvider } from '../../../src/auth/no-auth-provider.js';

async function createMockRequest(headers: Record<string, string> = {}) {
  const app = new Hono();
  let capturedReq: any;
  app.get('/test', (c) => {
    capturedReq = c.req;
    return c.text('ok');
  });
  await app.request('/test', { headers });
  return capturedReq;
}

describe('NoAuthProvider', () => {
  const provider = new NoAuthProvider();

  it('extracts tenantId from x-tenant-id header', async () => {
    const req = await createMockRequest({
      'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000',
    });
    const result = await provider.authenticate(req);
    expect(result.tenantId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.userId).toBe('anonymous');
    expect(result.scopes).toContain('admin');
  });

  it('throws AuthError when x-tenant-id header is missing', async () => {
    const req = await createMockRequest({});
    await expect(provider.authenticate(req)).rejects.toThrow('x-tenant-id header is required');
  });

  it('throws AuthError when x-tenant-id is not a valid UUID', async () => {
    const req = await createMockRequest({ 'x-tenant-id': 'not-a-uuid' });
    await expect(provider.authenticate(req)).rejects.toThrow('x-tenant-id must be a valid UUID');
  });
});
