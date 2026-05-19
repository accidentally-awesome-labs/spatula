import { createHash } from 'node:crypto';
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthMissingTokenError, AuthInvalidTokenError } from '@spatula/shared';
import type { HonoRequest } from 'hono';
import type { ApiKeyRepository } from '@spatula/db';

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(private readonly apiKeyRepo: ApiKeyRepository) {}

  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const authHeader = request.header('authorization');
    // Phase 16 plan 16-4 [Rule 1]: swap legacy `AuthError` (code: 'AUTH_ERROR')
    // for the typed DOMAIN.CODE subclasses introduced by plan 16-1. The
    // 16-1 grep-gate sweep covered routes/middleware/openapi-config.ts but
    // not apps/api/src/auth/ — so these throw-sites slipped through and the
    // contract-test errors suite (16-4 Task 2) surfaced them as `AUTH_ERROR`
    // envelope leaks. Use MISSING for absent/malformed headers, INVALID for
    // wrong-secret cases.
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
