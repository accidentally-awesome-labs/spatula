import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiKeyAuthProvider } from '../../../src/auth/api-key-provider.js';
import type { ApiKeyRepository } from '@accidentally-awesome-labs/spatula-db';

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

describe('ApiKeyAuthProvider', () => {
  let mockRepo: { findByHash: ReturnType<typeof vi.fn> };
  let provider: ApiKeyAuthProvider;

  beforeEach(() => {
    mockRepo = { findByHash: vi.fn() };
    provider = new ApiKeyAuthProvider(mockRepo as unknown as ApiKeyRepository);
  });

  it('authenticates a valid API key', async () => {
    mockRepo.findByHash.mockResolvedValue({
      id: 'key-1',
      tenantId: 'tenant-1',
      scopes: ['jobs:read', 'jobs:write'],
      revokedAt: null,
      expiresAt: null,
    });
    const req = await createMockRequest({
      authorization: 'Bearer sk_live_abcdef1234567890abcdef1234567890',
    });
    const result = await provider.authenticate(req);
    expect(result.tenantId).toBe('tenant-1');
    expect(result.userId).toBe('key-1');
    expect(result.scopes).toEqual(['jobs:read', 'jobs:write']);
    expect(mockRepo.findByHash).toHaveBeenCalledWith(expect.any(String));
  });

  it('throws AuthError when Authorization header is missing', async () => {
    const req = await createMockRequest({});
    await expect(provider.authenticate(req)).rejects.toThrow('Authorization header is required');
  });

  it('throws AuthError when Authorization header has wrong scheme', async () => {
    const req = await createMockRequest({ authorization: 'Basic abc123' });
    await expect(provider.authenticate(req)).rejects.toThrow('Bearer token required');
  });

  it('throws AuthError when API key is not found or revoked', async () => {
    mockRepo.findByHash.mockResolvedValue(null);
    const req = await createMockRequest({
      authorization: 'Bearer sk_live_abcdef1234567890abcdef1234567890',
    });
    await expect(provider.authenticate(req)).rejects.toThrow('Invalid or expired API key');
  });
});
