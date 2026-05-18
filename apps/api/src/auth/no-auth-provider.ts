import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthError } from '@spatula/shared';
import type { HonoRequest } from 'hono';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NoAuthProvider implements AuthProvider {
  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const tenantId = request.header('x-tenant-id');
    if (!tenantId) {
      throw new AuthError('x-tenant-id header is required');
    }
    if (!UUID_REGEX.test(tenantId)) {
      throw new AuthError('x-tenant-id must be a valid UUID');
    }

    return {
      tenantId,
      userId: 'anonymous',
      scopes: ['admin'],
      strategy: 'none',
    };
  }
}
