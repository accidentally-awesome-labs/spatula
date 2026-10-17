import {
  ACK_WINDOW_MS,
  acknowledgmentSchema,
  DIRECTORY_CONTENT_TYPE,
  DIRECTORY_PATH,
  hmacSha256Hex,
  importSigningKey,
  keyDirectory,
  packIssues,
  parseDefinition,
  randomNonce,
  RUN_SLOT_TAKEN,
  runIdFor,
  sha256Hex,
  signDirectory,
  type DatasetStatus,
  type RunView,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import {
  applyDefinition,
  countOpenReviews,
  datasetExists,
  finishRun,
  getDataset,
  getRun,
  getSnapshot,
  heldSnapshot,
  latestAcknowledgments,
  latestSnapshot,
  listOpenReviews,
  recordAcknowledgment,
  reviveItems,
  StaleDefinitionError,
  startRunAlone,
} from '@spatula/store';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { aboutPage } from './about';
import { r2Blobs } from './blobs';
import { consumerSecret, secret } from './config';
import { withDatabase } from './database';
import { answerReview } from './review';

/*
 * The owner's API, the consumers' routes, the public page, and the key directory. Callers send a
 * bearer token; the Worker keeps only SHA-256s and compares in constant time. Answers to callers
 * are personal, so nothing caches them, and the same goes for every other answer but the page and
 * the key directory: an unknown path's 404 and a failure's 500.
 */

/** `consumer` is who a route's `reader` found: a listed consumer's name, or null for the owner. */
type Api = { Bindings: Env; Variables: { consumer: string | null } };

/**
 * Every answer carries this but the public page and the key directory's (which a site may keep
 * for a few minutes). The owner and reader middlewares, notFound and onError set it with
 * c.header, which Hono copies into the responses it builds (c.json). A handler that returns a raw
 * Response has to set it by hand, as the snapshot route does.
 */
const PRIVATE_NO_STORE = 'private, no-store';

export const api = new Hono<Api>();

api.get('/', (c) => c.html(aboutPage(c.env)));

/** How long the key directory's signature is good for, and how long a client may keep the answer. */
const DIRECTORY_TTL_SECONDS = 600;

api.get(DIRECTORY_PATH, async (c) => {
  const jwk = secret(c.env, 'WEB_BOT_AUTH_KEY');
  if (jwk === undefined) {
    c.header('cache-control', PRIVATE_NO_STORE);
    return c.json({ error: 'This deployment doesn’t sign its requests yet.' }, 404);
  }
  const key = await importSigningKey(jwk);
  const signed = await signDirectory({
    authority: new URL(c.req.url).host,
    key,
    now: Date.now(),
    nonce: randomNonce(),
    ttlSeconds: DIRECTORY_TTL_SECONDS,
  });
  return new Response(keyDirectory(key), {
    headers: {
      'content-type': DIRECTORY_CONTENT_TYPE,
      // The key is public, and a client that keeps the answer half as long as it's signed for
      // always holds a signature that's still good.
      'cache-control': `public, max-age=${DIRECTORY_TTL_SECONDS / 2}`,
      ...signed,
    },
  });
});

/**
 * The bearer token sent, if any. The scheme's name is case-insensitive (RFC 9110); the token isn't.
 */
function bearer(c: { req: { header(name: string): string | undefined } }): string | undefined {
  return /^bearer (.+)$/iu.exec(c.req.header('authorization') ?? '')?.[1];
}

const owner: MiddlewareHandler<Api> = async (c, next) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  const expected = secret(c.env, 'OWNER_TOKEN_HASH');
  if (expected === undefined)
    return c.json({ error: 'This deployment has no owner token yet.' }, 503);
  const token = bearer(c);
  if (token === undefined || !sameText(await sha256Hex(token), expected.toLowerCase())) {
    c.header('www-authenticate', 'Bearer');
    return c.json({ error: 'The owner token is missing or wrong.' }, 401);
  }
  await next();
};

/**
 * The routes a consumer may call as well as the owner: reading a dataset's snapshots, and
 * acknowledging them. Every other route under /datasets is the owner's alone, including any added
 * later, so a new route can't be left open by mistake. A route is a method and a path, so one added
 * later at the same path with another method is the owner's too.
 */
const CONSUMER_ROUTES = [
  { method: 'GET', path: /^\/datasets\/[^/]+\/snapshots\/[^/]+$/u },
  { method: 'POST', path: /^\/datasets\/[^/]+\/acknowledgments$/u },
];

api.use('/datasets/*', async (c, next) =>
  CONSUMER_ROUTES.some(({ method, path }) => c.req.method === method && path.test(c.req.path))
    ? next()
    : owner(c, next),
);
api.use('/runs/*', owner);

/**
 * The owner, or a consumer the dataset lists. A consumer is known by its token alone: its hash is
 * compared, in constant time, with each listed consumer's. Who called is kept for the route.
 */
const reader: MiddlewareHandler<Api> = async (c, next) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  const ownerHash = secret(c.env, 'OWNER_TOKEN_HASH');
  if (ownerHash === undefined)
    return c.json({ error: 'This deployment has no owner token yet.' }, 503);
  const token = bearer(c);
  const refuse = () => {
    c.header('www-authenticate', 'Bearer');
    return c.json({ error: 'The token is missing or wrong.' }, 401);
  };
  if (token === undefined) return refuse();
  const hash = await sha256Hex(token);
  if (sameText(hash, ownerHash.toLowerCase())) {
    c.set('consumer', null);
    return next();
  }
  const dataset = await withDatabase(c.env, async (db) => {
    try {
      return await getDataset(db, c.req.param('id') ?? '');
    } catch (error) {
      // A consumer can't fix a definition, and a stranger mustn't learn of one.
      if (error instanceof StaleDefinitionError) return null;
      throw error;
    }
  });
  const consumer = dataset?.definition.consumers.find((name) => {
    const expected = consumerSecret(c.env, name, 'TOKEN_HASH');
    return expected !== undefined && sameText(hash, expected.toLowerCase());
  });
  // Whether the dataset exists isn't said to a token that can't read it.
  if (consumer === undefined) return refuse();
  c.set('consumer', consumer);
  return next();
};

api.put('/datasets/:id', async (c) => {
  const id = c.req.param('id');
  // A preview must never apply by mistake, so a flag that isn't 1 or 0 is refused, not guessed at.
  const flag = c.req.query('dryRun');
  if (flag !== undefined && flag !== '0' && flag !== '1') {
    return c.json({ error: 'dryRun is 1 or 0.' }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'The body isn’t JSON.' }, 400);
  }
  const parsed = parseDefinition(body);
  if (!parsed.ok)
    return c.json({ error: 'The definition has problems.', issues: parsed.issues }, 400);
  const { definition } = parsed;
  const issues = [
    ...(definition.dataset === id
      ? []
      : [`dataset: it says ${definition.dataset}, but the address says ${id}`]),
    ...packIssues(definition, packs),
  ];
  if (issues.length > 0) return c.json({ error: 'The definition has problems.', issues }, 400);
  const dryRun = flag === '1';
  return c.json(await withDatabase(c.env, (db) => applyDefinition(db, definition, { dryRun })));
});

api.post('/datasets/:id/runs', async (c) => {
  // Like dryRun, a flag that isn't 1 or 0 is refused, not guessed at.
  const all = c.req.query('all');
  if (all !== undefined && all !== '0' && all !== '1') {
    return c.json({ error: 'all is 1 or 0.' }, 400);
  }
  const datasetId = c.req.param('id');
  const now = new Date();
  const runId = runIdFor(datasetId, now);
  // The run is recorded first, so its ID can be reported at once, and a second request in the
  // same five-minute slot finds it. A dataset has one run going at a time: while another is, the
  // request is refused, and that run is named.
  const started = await withDatabase(c.env, async (db) => {
    // A definition stored by an earlier version that no longer passes the checks throws here, and
    // onError answers it.
    if ((await getDataset(db, datasetId)) === null) return 'missing' as const;
    return startRunAlone(db, { id: runId, datasetId, at: now });
  });
  if (started === 'missing') return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  if ('running' in started) {
    return c.json(
      {
        error: `A run of ${datasetId} is already running (${started.running.id}). Wait for it to finish.`,
        runId: started.running.id,
      },
      409,
    );
  }
  if (!started.created) return c.json({ error: RUN_SLOT_TAKEN, runId }, 409);
  try {
    await c.env.REFRESH.create({ id: runId, params: { runId, datasetId, all: all === '1' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withDatabase(c.env, (db) =>
      finishRun(db, runId, { status: 'failed', error: `The Workflow didn’t start: ${message}` }),
    );
    throw error;
  }
  c.header('location', `/runs/${runId}`);
  return c.json({ runId }, 202);
});

/**
 * How long a run's row may say `running` with no Workflow to find before it reads as failed. A
 * run's ID names its five-minute slot (runIdFor, platform/core/src/ids.ts), so five minutes after
 * the row was inserted its slot is over: a POST in a later slot gets another ID, and one in the
 * same slot finds this row and stops. No POST can still be about to create this Workflow.
 */
export const RUN_START_GRACE_MS = 5 * 60 * 1000;

api.get('/runs/:id', async (c) => {
  const run = await withDatabase(c.env, (db) => getRun(db, c.req.param('id')));
  if (run === null) return c.json({ error: 'No such run.' }, 404);
  if (run.status === 'running') {
    let instance: WorkflowInstance;
    try {
      instance = await c.env.REFRESH.get(run.id);
    } catch (error) {
      return c.json(withoutWorkflow(run, error));
    }
    // A Workflow stopped from outside, such as one terminated by hand, never finishes its run.
    const state = await instance.status();
    if (state.status === 'errored' || state.status === 'terminated') {
      const stopped: RunView = { ...run, status: 'failed', error: describeStop(state.error) };
      return c.json(stopped);
    }
  }
  return c.json(run);
});

api.get('/datasets/:id/snapshots/:generation', reader, async (c) => {
  const datasetId = c.req.param('id');
  const which = c.req.param('generation');
  // At most nine digits, so the number fits Postgres's integer column. A longer one would make
  // the query fail, and the route answer 500, instead of 400.
  if (which !== 'latest' && !/^[1-9]\d{0,8}$/u.test(which)) {
    return c.json({ error: 'A generation is a whole number from 1, or latest.' }, 400);
  }
  const row = await withDatabase(c.env, (db) =>
    which === 'latest' ? latestSnapshot(db, datasetId) : getSnapshot(db, datasetId, Number(which)),
  );
  if (row === null) return c.json({ error: 'No such snapshot.' }, 404);
  const file = await c.env.STORE.get(row.key);
  if (file === null) throw new Error(`The file for snapshot ${row.id} is missing from R2`);
  return new Response(file.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': PRIVATE_NO_STORE,
      'x-spatula-sha256': row.sha256,
      'x-spatula-generation': String(row.generation),
      'x-spatula-snapshot-id': row.id,
    },
  });
});

const reviveSchema = z
  .strictObject({
    refused: z.literal(true).optional(),
    pages: z.array(z.string().max(2048)).max(1000).optional(),
  })
  .refine((body) => body.refused === true || (body.pages?.length ?? 0) > 0);

api.post('/datasets/:id/items/revive', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'The body isn’t JSON.' }, 400);
  }
  const parsed = reviveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Send { "refused": true }, or { "pages": [addresses] }, or both.' },
      400,
    );
  }
  // A sitemap's pages are kept as their href, and a pages source's as the definition wrote them,
  // so an address is compared in both forms.
  const pages = parsed.data.pages?.flatMap((page) =>
    URL.canParse(page) ? [...new Set([page, new URL(page).href])] : [page],
  );
  const datasetId = c.req.param('id');
  const revived = await withDatabase(c.env, async (db) =>
    (await datasetExists(db, datasetId))
      ? reviveItems(db, { datasetId, refused: parsed.data.refused, pages })
      : null,
  );
  if (revived === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json({ revived });
});

api.get('/datasets/:id/review', async (c) => {
  const datasetId = c.req.param('id');
  // A dataset that isn't there has no questions, but an empty list would read as nothing waiting.
  const reviews = await withDatabase(c.env, async (db) =>
    (await datasetExists(db, datasetId)) ? listOpenReviews(db, datasetId) : null,
  );
  if (reviews === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json({ reviews });
});

const answerSchema = z.strictObject({ answer: z.string().min(1).max(600) });

api.post('/datasets/:id/review/:reviewId', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'The body isn’t JSON.' }, 400);
  }
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Send { "answer": one of the question’s options }.' }, 400);
  }
  const result = await answerReview(
    { withDb: (fn) => withDatabase(c.env, fn), blobs: r2Blobs(c.env.STORE), now: () => new Date() },
    { datasetId: c.req.param('id'), reviewId: c.req.param('reviewId'), answer: parsed.data.answer },
  );
  switch (result.kind) {
    case 'missing':
      return c.json({ error: 'No such question for this dataset.' }, 404);
    case 'closed':
      return c.json({ error: 'That question has been answered already.' }, 409);
    case 'refused':
      return c.json({ error: result.reason }, result.status);
    case 'answered':
      return c.json({
        answered: c.req.param('reviewId'),
        answer: parsed.data.answer,
        effect: result.effect,
      });
  }
});

api.post('/datasets/:id/acknowledgments', reader, async (c) => {
  const consumer = c.get('consumer');
  if (consumer === null) return c.json({ error: 'Acknowledgments come from consumers.' }, 403);
  const key = consumerSecret(c.env, consumer, 'HMAC_KEY');
  if (key === undefined) return c.json({ error: `${consumer} has no HMAC key yet.` }, 503);
  // The signature covers the exact bytes sent, so the body is read as text before it's parsed.
  const raw = await c.req.text();
  const signature = /^sha256=([0-9a-f]{64})$/u.exec(c.req.header('x-spatula-signature') ?? '')?.[1];
  if (signature === undefined || !sameText(signature, await hmacSha256Hex(key, raw))) {
    return c.json({ error: 'The signature is missing or wrong.' }, 401);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return c.json({ error: 'The body isn’t JSON.' }, 400);
  }
  const parsed = acknowledgmentSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(
      {
        error: `The acknowledgment is wrong at ${issue?.path.join('.') || 'the body'}: ${issue?.message}`,
      },
      400,
    );
  }
  const ack = parsed.data;
  const receivedAt = new Date();
  // An acknowledgment sent long ago may be a replay of one captured on the way.
  if (Math.abs(receivedAt.getTime() - Date.parse(ack.sentAt)) > ACK_WINDOW_MS) {
    return c.json({ error: 'sentAt is more than 10 minutes from Spatula’s clock.' }, 400);
  }
  const datasetId = c.req.param('id');
  const outcome = await withDatabase(c.env, async (db) => {
    const snapshot = await getSnapshot(db, datasetId, ack.generation);
    if (snapshot === null) return 'missing' as const;
    if (snapshot.id !== ack.snapshotId) return 'mismatch' as const;
    return recordAcknowledgment(db, {
      datasetId,
      consumer,
      generation: ack.generation,
      snapshotId: ack.snapshotId,
      outcome: ack.outcome,
      detail: ack.detail ?? null,
      counts: ack.counts ?? null,
      sentAt: new Date(ack.sentAt),
      receivedAt,
      bodySha256: await sha256Hex(raw),
    });
  });
  switch (outcome) {
    case 'missing':
      return c.json({ error: `Generation ${ack.generation} isn’t published.` }, 404);
    case 'mismatch':
      return c.json(
        { error: `Generation ${ack.generation} isn’t snapshot ${ack.snapshotId}.` },
        400,
      );
    case 'conflict':
      return c.json({ error: `Generation ${ack.generation} was acknowledged differently.` }, 409);
    case 'repeated':
      return c.json({ acknowledged: ack.generation }, 200);
    case 'recorded':
      return c.json({ acknowledged: ack.generation }, 201);
  }
});

api.get('/datasets/:id/status', async (c) => {
  const datasetId = c.req.param('id');
  const status = await withDatabase(c.env, async (db): Promise<DatasetStatus | null> => {
    const dataset = await getDataset(db, datasetId);
    if (dataset === null) return null;
    const held = await heldSnapshot(db, datasetId);
    const acks = await latestAcknowledgments(db, datasetId);
    return {
      dataset: datasetId,
      revision: dataset.revision,
      headGeneration: dataset.headGeneration,
      held:
        held === null
          ? null
          : {
              snapshotId: held.id,
              records: held.recordCount,
              reason: held.heldReason,
              createdAt: held.createdAt,
            },
      reviews: await countOpenReviews(db, datasetId),
      consumers: dataset.definition.consumers.map((name) => {
        const last = acks.find((ack) => ack.consumer === name);
        return {
          name,
          generation: last?.generation ?? null,
          outcome: last?.outcome ?? null,
          receivedAt: last?.receivedAt ?? null,
        };
      }),
    };
  });
  if (status === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json(status);
});

// These two answer whatever the path, including ones outside the owner routes, which set the
// header themselves.
api.notFound((c) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  return c.json({ error: 'Not found.' }, 404);
});

api.onError((error, c) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  // A definition stored by an earlier version that no longer passes the checks. The owner fixes it
  // by applying the definition again, and the message says so, so it's an answer, not a failure.
  if (error instanceof StaleDefinitionError) return c.json({ error: error.message }, 409);
  console.error('API error:', error instanceof Error ? error.message : String(error));
  return c.json({ error: 'Something went wrong. The Worker’s logs say what.' }, 500);
});

/** Compares two strings in time that doesn't depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/**
 * A run whose row says `running` but whose Workflow can't be found. Just after the row is
 * inserted that is normal: the POST that inserted it is about to create the Workflow. Once
 * RUN_START_GRACE_MS has passed it never will, so the run reads as failed. This only reports,
 * like the answer for a Workflow stopped from outside: the row stays as it is.
 */
function withoutWorkflow(run: RunView, error: unknown): RunView {
  if (Date.now() - Date.parse(run.startedAt) <= RUN_START_GRACE_MS) return run;
  const message = error instanceof Error ? error.message : String(error);
  return { ...run, status: 'failed', error: `Spatula can’t find this run’s Workflow: ${message}` };
}

function describeStop(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error)
    return String(error.message);
  return 'The Workflow stopped before the run finished.';
}
