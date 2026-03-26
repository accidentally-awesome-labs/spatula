import { createHash } from 'node:crypto';
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthError } from '@spatula/shared';
import type { HonoRequest } from 'hono';
import type { ApiKeyRepository } from '@spatula/db';

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(private readonly apiKeyRepo: ApiKeyRepository) {}

  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const authHeader = request.header('authorization');
    if (!authHeader) {
      throw new AuthError('Authorization header is required');
    }
    if (!authHeader.startsWith('Bearer ')) {
      throw new AuthError('Bearer token required');
    }

    const token = authHeader.slice(7);
    if (!token) {
      throw new AuthError('Bearer token is empty');
    }
    const keyHash = createHash('sha256').update(token).digest('hex');

    const apiKey = await this.apiKeyRepo.findByHash(keyHash);
    if (!apiKey) {
      throw new AuthError('Invalid or expired API key');
    }

    return {
      tenantId: apiKey.tenantId,
      userId: apiKey.id,
      scopes: apiKey.scopes,
    };
  }
}
