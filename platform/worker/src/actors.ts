import { sha256Hex, type ActorRecord } from '@spatula/core';
import { getDataset, StaleDefinitionError } from '@spatula/store';
import type { MiddlewareHandler } from 'hono';
import { consumerScopes, consumerSecret, SCOPES, secret, type Scope } from './config';
import { withDatabase } from './database';

/*
 * Who calls the review API (ADR 0009). The owner may do everything: through the CLI, with the owner
 * token, or through the console, signed in by Cloudflare Access (access.ts). A consumer the dataset
 * lists calls it with its own token, for its reviewers, within the scopes the owner granted it. Its
 * token stands for everyone at the consumer, so each write names the person answering.
 */

/** Who is calling, and what they may do. */
export interface Actor extends ActorRecord {
  scopes: readonly Scope[];
}

export type ActorApi = { Bindings: Env; Variables: { actor: Actor } };

/**
 * Every answer carries this but the public page and the key directory's (which a site may keep
 * for a few minutes). The guards, notFound and onError set it with c.header, which Hono copies into
 * the responses it builds (c.json). A handler that returns a raw Response has to set it by hand, as
 * the snapshot route does.
 */
export const PRIVATE_NO_STORE = 'private, no-store';

/**
 * The bearer token sent, if any. The scheme's name is case-insensitive (RFC 9110); the token isn't.
 */
export function bearer(c: {
  req: { header(name: string): string | undefined };
}): string | undefined {
  return /^bearer (.+)$/iu.exec(c.req.header('authorization') ?? '')?.[1];
}

/** Compares two strings in time that doesn't depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/**
 * The consumer, among those the dataset lists, whose token has this hash, or null. Each listed
 * consumer's hash is compared in constant time.
 */
export async function listedConsumer(
  env: Env,
  datasetId: string,
  tokenHash: string,
): Promise<string | null> {
  const dataset = await withDatabase(env, async (db) => {
    try {
      return await getDataset(db, datasetId);
    } catch (error) {
      // A consumer can't fix a definition, and a stranger mustn't learn of one.
      if (error instanceof StaleDefinitionError) return null;
      throw error;
    }
  });
  const consumer = dataset?.definition.consumers.find((name) => {
    const expected = consumerSecret(env, name, 'TOKEN_HASH');
    return expected !== undefined && sameText(tokenHash, expected.toLowerCase());
  });
  return consumer ?? null;
}

/** What answers and the log record of who called: not what they may do. */
export function actorRecord(actor: Actor): ActorRecord {
  return {
    role: actor.role,
    client: actor.client,
    ...(actor.consumer === undefined ? {} : { consumer: actor.consumer }),
    ...(actor.reviewer === undefined ? {} : { reviewer: actor.reviewer }),
  };
}

/** Whether a request writes: anything but a read. */
export function isWrite(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/**
 * The owner, by the owner token, or a consumer the dataset lists, by its own. A consumer is known
 * by its token alone, as on the snapshot routes.
 */
export const bearerActor: MiddlewareHandler<ActorApi> = async (c, next) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  const ownerHash = secret(c.env, 'OWNER_TOKEN_HASH');
  if (ownerHash === undefined) {
    return c.json({ error: 'This deployment has no owner token yet.' }, 503);
  }
  const token = bearer(c);
  const refuse = () => {
    c.header('www-authenticate', 'Bearer');
    return c.json({ error: 'The token is missing or wrong.' }, 401);
  };
  if (token === undefined) return refuse();
  const hash = await sha256Hex(token);
  if (sameText(hash, ownerHash.toLowerCase())) {
    c.set('actor', { role: 'owner', client: 'cli', scopes: SCOPES });
    return next();
  }
  const consumer = await listedConsumer(c.env, c.req.param('id') ?? '', hash);
  // Whether the dataset exists isn't said to a token that can't read it.
  if (consumer === null) return refuse();
  c.set('actor', {
    role: 'reviewer',
    client: 'consumer',
    consumer,
    scopes: consumerScopes(c.env, consumer),
  });
  return next();
};

/** Who answers for a consumer, as X-Spatula-Reviewer names them. */
const REVIEWER_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;

/**
 * A route that needs a scope, which the owner always has. A consumer's write names the person
 * answering in X-Spatula-Reviewer, which the answer and the log record, and the limiter counts by.
 */
export function needs(scope: Scope): MiddlewareHandler<ActorApi> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (!actor.scopes.includes(scope)) {
      return c.json(
        { error: `This needs the ${scope} scope, which the owner hasn’t granted.` },
        403,
      );
    }
    if (actor.role === 'reviewer' && isWrite(c.req.method)) {
      const reviewer = c.req.header('x-spatula-reviewer') ?? '';
      if (!REVIEWER_ID.test(reviewer)) {
        return c.json(
          {
            error:
              'Name the person answering in X-Spatula-Reviewer: 1 to 128 letters, digits, dots, underscores, colons, at signs, and hyphens.',
          },
          400,
        );
      }
      c.set('actor', { ...actor, reviewer });
    }
    return next();
  };
}

/** A route that is the owner's alone, though a consumer's token reaches it. */
export const ownerOnly: MiddlewareHandler<ActorApi> = async (c, next) => {
  if (c.get('actor').role !== 'owner') {
    return c.json({ error: 'Only the owner can do this.' }, 403);
  }
  return next();
};

/**
 * A write the limiters count (ruling 15): REVIEW_LIMITER takes 120 a minute from the owner, and
 * from each of a consumer's reviewers; CONSUMER_REVIEW_LIMITER takes 240 a minute from each
 * consumer's reviewers together. A consumer names its reviewers itself, so the consumer's count
 * comes first: a reviewer it names anew gets a fresh 120 of their own, but no more of the 240. A
 * bulk request is one write.
 */
export const limited: MiddlewareHandler<ActorApi> = async (c, next) => {
  const actor = c.get('actor');
  if (!(await withinLimits(c.env, actor))) {
    c.header('retry-after', '60');
    return c.json(
      {
        error:
          'That’s more writes this minute than the review API takes. Wait a minute, then send the rest.',
      },
      429,
    );
  }
  return next();
};

/** Whether the limiters take one more write from this caller (see limited). */
async function withinLimits(env: Env, actor: Actor): Promise<boolean> {
  if (actor.role === 'owner') return (await env.REVIEW_LIMITER.limit({ key: 'owner' })).success;
  const consumer = actor.consumer ?? '';
  if (!(await env.CONSUMER_REVIEW_LIMITER.limit({ key: consumer })).success) return false;
  const reviewer = `${consumer}:${actor.reviewer ?? ''}`;
  return (await env.REVIEW_LIMITER.limit({ key: reviewer })).success;
}
