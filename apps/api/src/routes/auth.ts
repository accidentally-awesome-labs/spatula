import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export function authRoutes() {
  const app = new Hono<AppEnv>();

  // GET /me — return the authenticated tenant + scopes.
  // Used by clients (including the spatula CLI `remote add` command) to verify
  // an API key is valid and discover assigned scopes. This is the canonical
  // auth-introspection endpoint as of v1.1.
  app.get('/me', (c) => {
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json(
        { error: { code: 'UNAUTHENTICATED', message: 'No tenant context' } },
        401,
      );
    }

    // Pull scopes + subject from the AuthResult set by authMiddleware.
    // auth.userId is empty string when NoAuthProvider is used; normalize to null
    // so callers see a clean `subject: null` instead of an empty string.
    const auth = c.get('auth') as { scopes?: string[]; userId?: string } | undefined;
    const scopes = auth?.scopes ?? [];
    const userId = auth?.userId ?? '';
    const subject = userId === '' ? null : userId;

    return c.json({
      tenantId,
      scopes,
      subject,
      authenticated: true as const,
    });
  });

  return app;
}
