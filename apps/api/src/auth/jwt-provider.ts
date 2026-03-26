import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthError } from '@spatula/shared';
import type { HonoRequest } from 'hono';

export interface JwtProviderConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export class JwtAuthProvider implements AuthProvider {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: JwtProviderConfig) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  }

  async authenticate(request: HonoRequest): Promise<AuthResult> {
    const authHeader = request.header('authorization');
    if (!authHeader) throw new AuthError('Authorization header is required');
    if (!authHeader.startsWith('Bearer ')) throw new AuthError('Bearer token required');
    const token = authHeader.slice(7);
    if (!token) throw new AuthError('Bearer token is empty');

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      payload = result.payload;
    } catch {
      throw new AuthError('Invalid or expired token');
    }

    const tenantId = payload.tenant_id as string | undefined;
    if (!tenantId) throw new AuthError('Missing tenant_id claim');

    return {
      tenantId,
      userId: payload.sub ?? 'unknown',
      scopes: (payload.scopes as string[] | undefined) ?? [],
    };
  }
}
