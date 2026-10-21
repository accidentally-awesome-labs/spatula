import type { Context, MiddlewareHandler } from 'hono';
import { decode, verifyWithJwks } from 'hono/jwt';
import { isWrite, PRIVATE_NO_STORE, type ActorApi } from './actors';
import { SCOPES, secret } from './config';

/*
 * The console's API sits behind Cloudflare Access (ADR 0009). Access signs the owner in, and sends
 * its token with each request it lets through, in Cf-Access-Jwt-Assertion. The Worker checks the
 * token itself, against the team's keys, for this application, and takes the owner's email alone:
 * a request that reached the Worker without passing Access gets nothing. A write must also come
 * from the console's own page, so another site can't make the owner's browser send one with
 * Access's cookie.
 */

/** One of Access's signing keys, as its certs endpoint lists them. */
type AccessKey = JsonWebKey & { kid?: string };

/** How long the Worker keeps Access's keys before it reads them again. */
const KEYS_TTL_MS = 10 * 60 * 1000;

/** Access's keys, by the address they were read from, with when. Each isolate keeps its own. */
const keysRead = new Map<string, { keys: AccessKey[]; readAt: number }>();

/**
 * The team's origin, the application's audience, and the owner's email: null until all three are
 * set, or while the team isn't an https address.
 */
function accessConfig(env: Env): { team: string; aud: string; owner: string } | null {
  const domain = secret(env, 'ACCESS_TEAM_DOMAIN');
  const aud = secret(env, 'ACCESS_AUD');
  const owner = secret(env, 'OWNER_EMAIL');
  if (domain === undefined || aud === undefined || owner === undefined) return null;
  if (!URL.canParse(domain)) return null;
  const url = new URL(domain);
  return url.protocol === 'https:' ? { team: url.origin, aud, owner } : null;
}

/**
 * Access's signing keys. They're kept ten minutes, and read again sooner for a key ID they don't
 * hold, as when Access rotates its keys. Failing to read them is the Worker's trouble, not the
 * caller's, so it throws, and the API answers 500.
 */
async function accessKeys(team: string, kid: string): Promise<AccessKey[]> {
  const url = `${team}/cdn-cgi/access/certs`;
  const kept = keysRead.get(url);
  if (
    kept !== undefined &&
    Date.now() - kept.readAt < KEYS_TTL_MS &&
    kept.keys.some((key) => key.kid === kid)
  ) {
    return kept.keys;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Access’s keys answered ${response.status}`);
  const body: unknown = await response.json();
  const keys =
    typeof body === 'object' && body !== null ? (body as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) throw new Error('Access’s keys came without a list of keys');
  const read = { keys: keys as AccessKey[], readAt: Date.now() };
  keysRead.set(url, read);
  return read.keys;
}

/**
 * The email of the person Access signed in, from the token Access sent with the request. Null when
 * there's none, or it doesn't check out: signed by another key or another way, for another team or
 * application, expired, not good yet, or without an expiry, which every token Access signs has.
 */
export async function accessEmail(env: Env, request: Request): Promise<string | null> {
  const config = accessConfig(env);
  const token = request.headers.get('cf-access-jwt-assertion');
  if (config === null || token === null) return null;
  let kid: string | undefined;
  try {
    kid = decode(token).header.kid;
  } catch {
    return null;
  }
  if (kid === undefined) return null;
  const keys = await accessKeys(config.team, kid);
  const payload = await verifyWithJwks(token, {
    keys,
    // Access signs with RS256. Allowing nothing else refuses a token that names another
    // algorithm, such as one signed with a shared secret.
    allowedAlgorithms: ['RS256'],
    verification: { iss: config.team, aud: config.aud },
  }).catch(() => null);
  // Hono checks the expiry only of a token that has one.
  if (payload === null || typeof payload.exp !== 'number') return null;
  return typeof payload.email === 'string' ? payload.email : null;
}

/**
 * The console's guard: the owner, signed in by Access, with every scope. A write needs the
 * console's own origin besides.
 */
export const accessActor: MiddlewareHandler<ActorApi> = async (c, next) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  const config = accessConfig(c.env);
  if (config === null) {
    return c.json({ error: 'This deployment’s console isn’t set up yet.' }, 503);
  }
  const email = await accessEmail(c.env, c.req.raw);
  if (email === null) {
    return c.json({ error: 'Cloudflare Access’s token is missing or wrong.' }, 401);
  }
  // An address's case doesn't make it another address.
  if (email.toLowerCase() !== config.owner.toLowerCase()) {
    return c.json({ error: 'The console is the owner’s.' }, 403);
  }
  if (isWrite(c.req.method) && !fromTheConsole(c)) {
    return c.json({ error: 'A console write comes from the console’s own page.' }, 403);
  }
  c.set('actor', { role: 'owner', client: 'console', scopes: SCOPES });
  return next();
};

/**
 * Whether a request comes from the console's own page: its Origin is the Worker's, and its
 * Sec-Fetch-Site, which a browser sets and a page can't, says same-origin when it's there. Access's
 * cookie is SameSite, and this refuses what a cookie sent from another site would still carry.
 */
function fromTheConsole(c: Context<ActorApi>): boolean {
  const site = c.req.header('sec-fetch-site');
  return (
    c.req.header('origin') === new URL(c.req.url).origin &&
    (site === undefined || site === 'same-origin')
  );
}
