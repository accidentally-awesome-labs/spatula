import { createHash } from 'node:crypto';
import type { AuthProvider, AuthResult } from '@accidentally-awesome-labs/spatula-shared';
import {
  AuthMissingTokenError,
  AuthInvalidTokenError,
} from '@accidentally-awesome-labs/spatula-shared';
import type { HonoRequest } from 'hono';
import type { ApiKeyRepository } from '@accidentally-awesome-labs/spatula-db';

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(private readonly apiKeyRepo: ApiKeyRepository) {}

  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const authHeader = request.header('authorization');
    // Use MISSING for absent/malformed headers and INVALID for wrong-secret
    // cases so error envelopes stay stable.
    if (!authHeader) {
      throw new AuthMissingTokenError('Authorization header is required');
    }
    if (!authHeader.startsWith('Bearer ')) {
      throw new AuthMissingTokenError('Bearer token required');
    }

    const token = authHeader.slice(7);
    if (!token) {
      throw new AuthMissingTokenError('Bearer token is empty');
    }
    const keyHash = createHash('sha256').update(token).digest('hex');

    const apiKey = await this.apiKeyRepo.findByHash(keyHash);
    if (!apiKey) {
      throw new AuthInvalidTokenError('Invalid or expired API key');
    }

    return {
      tenantId: apiKey.tenantId,
      userId: apiKey.id,
      scopes: apiKey.scopes,
      strategy: 'api-key',
    };
  }
}
