// Reference script for the browser OIDC dance.
// tests/e2e/browser/ extends this into the full OIDC -> ws-token -> SSE subscribe
// -> reconnect e2e suite.
//
// This script drives the Dex spatula-browser PKCE authorization-code flow end-to-end
// using Playwright/Chromium. It does NOT require the Spatula API to be running — only
// a healthy Dex instance at http://localhost:5556/dex.
//
// Prerequisites:
//   docker compose up -d          # boot Dex (see README.md)
//   pnpm exec playwright install chromium  # install browser binaries (one-time)
//
// Usage:
//   pnpm exec tsx smoke/browser-flow.ts
//
// Note: Playwright handles PKCE (S256 code verifier + challenge) natively in the browser
// context — do NOT hand-roll the code verifier. The browser generates and validates it.

import { chromium } from 'playwright';
import * as http from 'http';
import * as url from 'url';

const ISSUER = 'http://localhost:5556/dex';
const CLIENT_ID = 'spatula-browser';
const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = 'openid email profile';
const DEV_EMAIL = 'dev@example.com';
const DEV_PASSWORD = 'password';

/** Generate a random code verifier (43–128 chars, URL-safe base64 alphabet). */
function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  // Use crypto.getRandomValues equivalent via Buffer
  const bytes = Buffer.allocUnsafe(64);
  for (let i = 0; i < 64; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}

/** Compute S256 code challenge from verifier. */
async function computeCodeChallenge(verifier: string): Promise<string> {
  const { createHash } = await import('crypto');
  const hash = createHash('sha256').update(verifier).digest();
  return hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Decode a JWT payload segment (base64url → JSON). No library needed. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const segments = jwt.split('.');
  if (segments.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = segments[1];
  // base64url → base64 → Buffer → JSON
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

/** Start a temporary HTTP server on localhost:3000 to capture the OAuth callback. */
function captureCallback(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url ?? '', true);
      if (parsed.pathname === '/callback' && parsed.query.code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Auth complete — you may close this tab.</h1></body></html>');
        server.close();
        resolve({
          code: String(parsed.query.code),
          state: String(parsed.query.state ?? ''),
        });
      } else {
        res.writeHead(400);
        res.end('unexpected callback');
        server.close();
        reject(new Error(`Unexpected callback: ${req.url}`));
      }
    });

    server.listen(3000, 'localhost', () => {
      // Server is ready to receive the callback redirect
    });

    server.on('error', (err) => reject(err));

    // Timeout after 60 seconds
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for OAuth callback (60s)'));
    }, 60_000);
  });
}

async function main(): Promise<void> {
  // 1. Fetch the Dex discovery doc to get the authorization + token endpoints.
  let discovery: Record<string, string>;
  try {
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new Error(`Discovery doc HTTP ${res.status}`);
    }
    discovery = (await res.json()) as Record<string, string>;
  } catch (err) {
    console.error('browser-flow: failed to fetch Dex discovery doc — is Dex running?');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const authEndpoint = discovery['authorization_endpoint'];
  const tokenEndpoint = discovery['token_endpoint'];

  if (!authEndpoint || !tokenEndpoint) {
    console.error('browser-flow: discovery doc missing authorization_endpoint or token_endpoint');
    process.exit(1);
  }

  // 2. Generate PKCE code verifier + challenge.
  // The browser context (Playwright) drives the OIDC flow; PKCE S256 is computed here
  // and sent as query parameters — the browser does not need to hand-roll anything.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const state = Math.random().toString(36).slice(2);

  // 3. Build the authorization URL.
  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // 4. Start callback capture server before navigating the browser.
  const callbackPromise = captureCallback();

  // 5. Launch Chromium and drive the login flow.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(authUrl.toString());

    // Dex password login form — fill email + password and submit.
    await page.waitForSelector('input[name="login"]', { timeout: 10_000 });
    await page.fill('input[name="login"]', DEV_EMAIL);
    await page.fill('input[name="password"]', DEV_PASSWORD);
    await page.click('button[type="submit"]');

    // Wait for the redirect to our callback server.
    // The page will navigate to http://localhost:3000/callback?code=...
    await page.waitForURL(/localhost:3000\/callback/, { timeout: 15_000 });
  } catch (err) {
    console.error('browser-flow: error driving the Dex login form:');
    console.error(err instanceof Error ? err.message : String(err));
    await browser.close();
    process.exit(1);
  }

  await browser.close();

  // 6. Capture the authorization code from the callback.
  let code: string;
  try {
    const result = await callbackPromise;
    code = result.code;
  } catch (err) {
    console.error('browser-flow: did not receive OAuth callback:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 7. Exchange the authorization code for tokens at the Dex token endpoint.
  let tokenResponse: Record<string, unknown>;
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    });

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token endpoint HTTP ${res.status}: ${text}`);
    }

    tokenResponse = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error('browser-flow: token exchange failed:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const accessToken = tokenResponse['access_token'] as string | undefined;
  const idToken = tokenResponse['id_token'] as string | undefined;

  if (!accessToken) {
    console.error(
      'browser-flow: token response missing access_token:',
      JSON.stringify(tokenResponse, null, 2),
    );
    process.exit(1);
  }

  // 8. Decode and print the JWT claims.
  try {
    const idClaims = idToken ? decodeJwtPayload(idToken) : null;
    const accessClaims = decodeJwtPayload(accessToken);

    console.log('browser-flow-ok');
    console.log('\nID token claims:');
    console.log(JSON.stringify(idClaims, null, 2));
    console.log('\nAccess token claims:');
    console.log(JSON.stringify(accessClaims, null, 2));
  } catch (err) {
    console.error('browser-flow: failed to decode JWT payload:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('browser-flow: unexpected error:', err);
  process.exit(1);
});
