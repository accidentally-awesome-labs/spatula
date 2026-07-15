import type { AuthProvider, AuthResult } from '@accidentally-awesome-labs/spatula-shared';
import {
  AuthMissingTokenError,
  AuthInvalidTokenError,
} from '@accidentally-awesome-labs/spatula-shared';
import type { HonoRequest } from 'hono';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NoAuthProvider implements AuthProvider {
  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const tenantId = request.header('x-tenant-id');
    // x-tenant-id functions as identity in dev/no-auth mode, so MISSING covers
    // absence and INVALID covers a malformed value.
    if (!tenantId) {
      throw new AuthMissingTokenError('x-tenant-id header is required');
    }
    if (!UUID_REGEX.test(tenantId)) {
      throw new AuthInvalidTokenError('x-tenant-id must be a valid UUID');
    }

    return {
      tenantId,
      userId: 'anonymous',
      scopes: ['admin'],
      strategy: 'none',
    };
  }
}
