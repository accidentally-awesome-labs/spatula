import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AuthProvider, AuthResult } from '@spatula/shared';
import { AuthMissingTokenError, AuthInvalidTokenError } from '@spatula/shared';
import type { HonoRequest } from 'hono';

export interface JwtProviderConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /**
   * Server-side scope grant for registered M2M clients.
   *
   * Maps a M2M client identity string (the `client_id` that Dex encodes into the
   * JWT `sub` claim via a protobuf blob) to the explicit scope set that client
   * is authorised to use.
   *
   * WHY THIS EXISTS:
   * Dex `client_credentials` JWTs carry no application-level `scopes` claim —
   * Dex only accepts OIDC-standard scopes (`openid`, `profile`, `email`) and
   * rejects custom scopes with `invalid_scope`. The token payload therefore
   * arrives with no scope information at all.
   *
   * The correct fix is NOT to fall back to a default scope set for every
   * scope-less JWT (that would fail-open: any browser OIDC user whose token
   * lacks a `scopes` claim would silently get full API access).
   *
   * Instead, only tokens whose `sub` is positively identified as a registered
   * M2M client identity receive that client's explicitly configured scopes.
   * All other scope-less JWTs resolve to `[]` (fail-closed).
   *
   * IDENTITY CHECK:
   * Dex encodes the client_credentials `sub` as a base64url protobuf message
   * (field 1 = the client_id string). We accept two forms:
   *   1. Literal match: `sub === clientId` (future Dex may simplify this)
   *   2. Protobuf decode: base64url(sub) bytes contain the clientId UTF-8 string
   *
   * Example config (in e2e / integration tests only — not in production server
   * unless a real M2M client is registered):
   *   m2mClientScopes: { 'spatula-m2m': ['jobs:read', 'jobs:write', ...] }
   */
  m2mClientScopes?: Record<string, string[]>;
}

/**
 * Returns true if the JWT `sub` value encodes the given clientId.
 * Handles both literal and Dex-protobuf-encoded forms.
 */
function subEncodesClientId(sub: string, clientId: string): boolean {
  if (sub === clientId) return true;
  try {
    const base64 = sub.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return Buffer.from(padded, 'base64').toString('utf8').includes(clientId);
  } catch {
    return false;
  }
}

export class JwtAuthProvider implements AuthProvider {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly m2mClientScopes: Record<string, string[]>;

  constructor(config: JwtProviderConfig) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
    this.m2mClientScopes = config.m2mClientScopes ?? {};
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

    // Resolve scopes. Auth MUST fail closed: a JWT with no explicit `scopes`
    // claim resolves to [] — never to a default full set. This prevents a
    // browser OIDC user whose token lacks a `scopes` claim from silently
    // receiving full API access.
    //
    // The only exception is a positively-identified M2M client whose identity
    // is explicitly registered in `m2mClientScopes`. Only that specific client
    // identity receives the configured scope set; every other scope-less JWT
    // remains [].
    const jwtScopes = payload.scopes as string[] | undefined;
    let scopes: string[] = jwtScopes && jwtScopes.length > 0 ? jwtScopes : [];

    if (scopes.length === 0) {
      const sub = payload.sub ?? '';
      for (const [clientId, clientScopes] of Object.entries(this.m2mClientScopes)) {
        if (subEncodesClientId(sub, clientId)) {
          scopes = clientScopes;
          break;
        }
      }
    }

    return {
      tenantId: '', // Resolved by auth middleware via user_tenants lookup
      userId: payload.sub ?? 'unknown',
      scopes,
      strategy: 'jwt',
      displayName: (payload.name as string | undefined) ?? (payload.email as string | undefined),
    };
  }
}
