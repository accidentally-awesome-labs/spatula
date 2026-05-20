import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthMissingTokenError, AuthInvalidTokenError, DEFAULT_API_KEY_SCOPES } from '@spatula/shared';
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
    // Phase 16 plan 16-4 [Rule 1]: typed DOMAIN.CODE subclasses (MISSING for
    // absent headers, INVALID for failed verification). Same fix as
    // api-key-provider.ts — slipped through plan 16-1's grep sweep because
    // apps/api/src/auth/ was outside the scanned path tree.
    if (!authHeader) throw new AuthMissingTokenError('Authorization header is required');
    if (!authHeader.startsWith('Bearer ')) throw new AuthMissingTokenError('Bearer token required');
    const token = authHeader.slice(7);
    if (!token) throw new AuthMissingTokenError('Bearer token is empty');

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      payload = result.payload;
    } catch {
      throw new AuthInvalidTokenError('Invalid or expired token');
    }

    // Resolve scopes from JWT claims. Dex client_credentials tokens do not carry
    // a custom `scopes` claim by default, so we fall back to DEFAULT_API_KEY_SCOPES
    // (the standard set granted to API keys). M2M clients should have the same
    // access surface as API keys unless the JWT explicitly restricts it.
    const jwtScopes = payload.scopes as string[] | undefined;
    const scopes = jwtScopes && jwtScopes.length > 0 ? jwtScopes : DEFAULT_API_KEY_SCOPES;

    return {
      tenantId: '', // Resolved by auth middleware via user_tenants lookup
      userId: payload.sub ?? 'unknown',
      scopes,
      strategy: 'jwt',
      displayName: (payload.name as string | undefined) ?? (payload.email as string | undefined),
    };
  }
}
