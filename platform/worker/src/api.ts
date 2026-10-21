import {
  ACK_WINDOW_MS,
  acknowledgmentSchema,
  DIRECTORY_CONTENT_TYPE,
  DIRECTORY_PATH,
  hasTaxonomy,
  hmacSha256Hex,
  importSigningKey,
  keyDirectory,
  newId,
  packIssues,
  parseDefinition,
  randomNonce,
  RUN_SLOT_TAKEN,
  runIdFor,
  seedTaxonomy,
  sha256Hex,
  signDirectory,
  taxonomySeedSchema,
  type DatasetStatus,
  type EvalScores,
  type RunView,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import {
  applyDefinition,
  countOpenReviews,
  currentTaxonomy,
  datasetExists,
  finishRun,
  getDataset,
  getRun,
  getSnapshot,
  heldSnapshot,
  latestAcknowledgments,
  latestSnapshot,
  listDatasets,
  listEvals,
  listItems,
  lockDataset,
  purgeKeys,
  purgeSource,
  recordAcknowledgment,
  reviveItems,
  reviveSources,
  runningRun,
  saveEval,
  seedTaxonomyVersion,
  sourceStates,
  StaleDefinitionError,
  startRunAlone,
} from '@spatula/store';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { aboutPage } from './about';
import { accessActor } from './access';
import {
  actorRecord,
  bearer,
  bearerActor,
  listedConsumer,
  ownerOnly,
  PRIVATE_NO_STORE,
  sameText,
  type ActorApi,
} from './actors';
import { r2Blobs } from './blobs';
import { captureRoutes } from './capture-api';
import { rawPageKey } from './captures';
import { consumerSecret, secret, verifiedBot } from './config';
import { consolePages } from './console/routes';
import { withDatabase } from './database';
import { pageKey } from './pipeline';
import { proposalRoutes } from './proposal-api';
import { reviewRoutes } from './review-api';

/*
 * The owner's API, the consumers' routes, the review API (review-api.ts), the console's API, the
 * public page, and the key directory. Callers send a bearer token, and the console's API takes
 * Cloudflare Access's instead (access.ts); the Worker keeps only SHA-256s of bearer tokens and
 * compares in constant time. Answers to callers are personal, so nothing caches them, and the same
 * goes for every other answer but the page and the key directory: an unknown path's 404 and a
 * failure's 500.
 */

/** `consumer` is who a route's `reader` found: a listed consumer's name, or null for the owner. */
type Api = { Bindings: Env; Variables: { consumer: string | null } };

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
 * acknowledging them; and the review API's, the taxonomy's, and the proposals' and autonomy's,
 * which check the token themselves (bearerActor), and answer a consumer with a 403 on the owner's
 * among them: suggestions, the log, seeding, versions, undo, autonomy, and a capture. Every other
 * route under /datasets is the owner's alone, including any added later, so a new route can't be
 * left open by mistake. A route is a method and a path, so one added later at the same path with
 * another method is the owner's too, and so is one added later at a path of the snapshot route's
 * shape: the pattern is the snapshot route's own forms, `latest` and a generation of up to nine
 * digits from 1 (see the route, which answers any other with a 400). An answer's path takes a
 * question's ID, which starts `rv_`, and a decision's a proposal's, which starts `tp_`.
 */
const CONSUMER_ROUTES = [
  { method: 'GET', path: /^\/datasets\/[^/]+\/snapshots\/(?:latest|[1-9]\d{0,8})$/u },
  { method: 'POST', path: /^\/datasets\/[^/]+\/acknowledgments$/u },
  { method: 'GET', path: /^\/datasets\/[^/]+\/review(?:\/log)?$/u },
  { method: 'POST', path: /^\/datasets\/[^/]+\/review\/(?:bulk|suggestions|rv_[^/]+)$/u },
  { method: 'GET', path: /^\/datasets\/[^/]+\/taxonomy$/u },
  { method: 'POST', path: /^\/datasets\/[^/]+\/taxonomy$/u },
  // The taxonomy's proposals, versions, and autonomy (ADR 0007). A reviewer with
  // taxonomy:approve-additive lists and decides the additive kinds. On the owner's routes among
  // them, a consumer gets ownerOnly's 403, not the owner check's 401. Each path is under
  // ACTOR_PATHS, where bearerActor knows the caller.
  { method: 'GET', path: /^\/datasets\/[^/]+\/proposals$/u },
  { method: 'POST', path: /^\/datasets\/[^/]+\/proposals\/tp_[^/]+$/u },
  { method: 'GET', path: /^\/datasets\/[^/]+\/taxonomy\/versions$/u },
  { method: 'POST', path: /^\/datasets\/[^/]+\/taxonomy\/versions\/[1-9]\d{0,8}\/undo$/u },
  { method: 'GET', path: /^\/datasets\/[^/]+\/autonomy$/u },
  { method: 'POST', path: /^\/datasets\/[^/]+\/autonomy\/[a-z-]{1,40}\/revoke$/u },
  // The owner's capture route, listed so a consumer's token reaches ownerOnly and gets its 403,
  // not the owner check's 401 (Review Focus 3). The path is under ACTOR_PATHS, so bearerActor
  // answers a request without a token or with a wrong one. Plan 1's POST …/captures/purge is not
  // listed: it stays behind the owner check.
  { method: 'GET', path: /^\/datasets\/[^/]+\/captures\/[^/]+$/u },
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
  const consumer = await listedConsumer(c.env, c.req.param('id') ?? '', hash);
  // Whether the dataset exists isn't said to a token that can't read it.
  if (consumer === null) return refuse();
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
  // A backfill-only run decides again, from captures, what a taxonomy change touched (ADR 0008).
  const backfill = c.req.query('backfill');
  if (backfill !== undefined && backfill !== '0' && backfill !== '1') {
    return c.json({ error: 'backfill is 1 or 0.' }, 400);
  }
  if (all === '1' && backfill === '1') {
    return c.json(
      { error: 'A backfill run reads no page, so it can’t count every page as due.' },
      400,
    );
  }
  const datasetId = c.req.param('id');
  const now = new Date();
  const runId = runIdFor(datasetId, now);
  // The run is recorded first, so its ID can be reported at once, and a second request in the
  // same five-minute slot finds it. A dataset has one run going at a time: while another is, the
  // request is refused, and that run is named, with when it started. A run that reads as failed
  // (see viewRun) isn't going, and mustn't block its dataset: the start records its failure, which
  // GET /runs/:id only reports, and tries once more. Should that run's Workflow finish it after
  // all, finishRun lets a failed run complete, so the row ends up saying how it ended.
  const started = await withDatabase(c.env, async (db) => {
    // A definition stored by an earlier version that no longer passes the checks throws here, and
    // onError answers it.
    const dataset = await getDataset(db, datasetId);
    if (dataset === null) return 'missing' as const;
    // A backfill places pages in the dataset's taxonomy, so the record type must have one, and it
    // must be seeded. A decided enum isn't a taxonomy.
    if (
      backfill === '1' &&
      (!Object.values(dataset.definition.recordTypes).some(hasTaxonomy) ||
        (await currentTaxonomy(db, datasetId)) === null)
    ) {
      return 'no taxonomy' as const;
    }
    const first = await startRunAlone(db, { id: runId, datasetId });
    if (!('running' in first)) return first;
    const view = await viewRun(c.env, first.running);
    // Every run viewRun reads as failed has its reason, so a missing one is not a run to record.
    if (view.status !== 'failed' || view.error === null) return first;
    await finishRun(db, view.id, { status: 'failed', error: view.error });
    // Once: the answer to this attempt is the answer, even if another run is in the way.
    return startRunAlone(db, { id: runId, datasetId });
  });
  if (started === 'missing') return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  if (started === 'no taxonomy') {
    return c.json({ error: `${datasetId} has no taxonomy to backfill.` }, 409);
  }
  if ('running' in started) {
    const going = started.running;
    const since = ago(now.getTime() - Date.parse(going.startedAt));
    return c.json(
      {
        error: `A run of ${datasetId} is already running (${going.id}, started ${since}). Wait for it to finish.`,
        runId: going.id,
      },
      409,
    );
  }
  if (!started.created) return c.json({ error: RUN_SLOT_TAKEN, runId }, 409);
  try {
    await c.env.REFRESH.create({
      id: runId,
      params: { runId, datasetId, all: all === '1', backfill: backfill === '1' },
    });
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

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long a run whose Workflow reads as neither going nor stopped (`complete` or `unknown`, while
 * the run's row still says running) keeps holding its dataset. Past it, the run reads as failed
 * (viewRun), so the next start records it and starts. A Workflow that reads as going blocks the
 * next start however long it runs, and one that has stopped, or can't be found once
 * RUN_START_GRACE_MS has passed, never does.
 */
export const RUN_STALE_MS = 6 * HOUR_MS;

/**
 * What a Workflow still at work reads as, among the Worker's InstanceStatus type's statuses. One
 * rolling back is still running code, so it counts.
 */
const GOING: ReadonlySet<InstanceStatus['status']> = new Set([
  'queued',
  'running',
  'waiting',
  'paused',
  'waitingForPause',
  'rollingBack',
]);

api.get('/runs/:id', async (c) => {
  const run = await withDatabase(c.env, (db) => getRun(db, c.req.param('id')));
  if (run === null) return c.json({ error: 'No such run.' }, 404);
  return c.json(await viewRun(c.env, run));
});

/**
 * A run as the API reports it. A row that says `running` is checked against its Workflow: one that
 * was stopped from outside, such as one terminated by hand, never finishes its run, and one that
 * can't be found never will once RUN_START_GRACE_MS has passed, so both read as failed. So does one
 * past RUN_STALE_MS whose Workflow reads as neither going nor stopped. Any other row is reported as
 * it is. This only reports: GET /runs/:id leaves the row alone, and the start of the dataset's next
 * run records the failure.
 */
async function viewRun(env: Env, run: RunView): Promise<RunView> {
  if (run.status !== 'running') return run;
  let instance: WorkflowInstance;
  try {
    instance = await env.REFRESH.get(run.id);
  } catch (error) {
    return withoutWorkflow(run, error);
  }
  const state = await instance.status();
  if (state.status === 'errored' || state.status === 'terminated') {
    return { ...run, status: 'failed', error: describeStop(state.error) };
  }
  if (!GOING.has(state.status) && Date.now() - Date.parse(run.startedAt) > RUN_STALE_MS) {
    return {
      ...run,
      status: 'failed',
      error: `This run’s Workflow reads ${state.status}, though the run never finished, and it started more than ${RUN_STALE_MS / HOUR_MS} hours ago.`,
    };
  }
  return run;
}

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
    irrelevant: z.literal(true).optional(),
    fromCaptures: z.literal(true).optional(),
    pages: z.array(z.string().max(2048)).max(1000).optional(),
  })
  .refine(
    (body) => body.refused === true || body.irrelevant === true || (body.pages?.length ?? 0) > 0,
  );

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
      {
        error:
          'Send { "refused": true }, { "irrelevant": true }, or { "pages": [addresses] }, with "fromCaptures": true to read irrelevant pages again from their captures.',
      },
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
      ? reviveItems(db, {
          datasetId,
          refused: parsed.data.refused,
          irrelevant: parsed.data.irrelevant,
          fromCaptures: parsed.data.fromCaptures,
          pages,
        })
      : null,
  );
  if (revived === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json({ revived });
});

const reviveSourcesSchema = z.strictObject({
  // Source IDs are slugs of up to 63 characters (definition.ts).
  sources: z.array(z.string().min(1).max(63)).min(1).max(100),
});

/** Puts blocked or refused sources back (ADR 0006): their count starts again, and they're live. */
api.post('/datasets/:id/sources/revive', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'The body isn’t JSON.' }, 400);
  }
  const parsed = reviveSourcesSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Send { "sources": [source IDs] }.' }, 400);
  const datasetId = c.req.param('id');
  const revived = await withDatabase(c.env, async (db) =>
    (await datasetExists(db, datasetId))
      ? reviveSources(db, { datasetId, sources: parsed.data.sources })
      : null,
  );
  if (revived === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json({ revived });
});

const purgeSchema = z.strictObject({
  // Source IDs are slugs of up to 63 characters (definition.ts).
  source: z.string().min(1).max(63),
});

/**
 * Deletes a source's captures (ADR 0008), for when a site asks, a policy changes, or a source is
 * retired: the files first, then the rows, so a purge that fails partway is finished by running it
 * again. Not while a run of the dataset is going, which could capture the source's pages again as
 * they're deleted; a run whose Workflow has stopped doesn't count (viewRun). The source stays in the
 * definition, and its statements stay.
 *
 * The whole purge is one transaction holding the dataset's lock, which starting a run takes too
 * (`startRunAlone`): that is what keeps a run from starting between the check for a run and the
 * deletes. A run that has started already is seen by the check.
 */
api.post('/datasets/:id/captures/purge', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'The body isn’t JSON.' }, 400);
  }
  const parsed = purgeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Send { "source": a source ID }.' }, 400);
  const datasetId = c.req.param('id');
  const sourceId = parsed.data.source;
  const outcome = await withDatabase(c.env, (db) =>
    db.transaction(async (tx) => {
      await lockDataset(tx, datasetId);
      if (!(await datasetExists(tx, datasetId))) {
        return { refusal: { error: `Dataset ${datasetId} doesn’t exist.`, status: 404 as const } };
      }
      const keys = await purgeKeys(tx, { datasetId, sourceId });
      if (keys === null) {
        return {
          refusal: {
            error: `${datasetId} has no source called ${sourceId}.`,
            status: 404 as const,
          },
        };
      }
      const going = await runningRun(tx, datasetId);
      const view = going === null ? null : await viewRun(c.env, going);
      if (view?.status === 'running') {
        return {
          refusal: {
            error: `A run of ${datasetId} is going (${view.id}). Purge once it has finished.`,
            runId: view.id,
            status: 409 as const,
          },
        };
      }
      await r2Blobs(c.env.STORE).delete([
        ...keys.hashes.flatMap((hash) => [pageKey(hash), rawPageKey(hash)]),
        ...keys.reads,
      ]);
      const purged = await purgeSource(tx, { datasetId, sourceId });
      return { purged: { ...purged, bodies: keys.hashes.length } };
    }),
  );
  if (outcome.refusal !== undefined) {
    const { status, ...answer } = outcome.refusal;
    return c.json(answer, status);
  }
  return c.json({ purged: outcome.purged });
});

/** Crowdio's acknowledgments are a few hundred bytes. The limit bounds what one can store. */
const ACK_MAX_BYTES = 16 * 1024;

api.post(
  '/datasets/:id/acknowledgments',
  reader,
  bodyLimit({
    maxSize: ACK_MAX_BYTES,
    onError: (c) =>
      c.json({ error: `An acknowledgment is at most ${ACK_MAX_BYTES / 1024} KiB.` }, 413),
  }),
  async (c) => {
    const consumer = c.get('consumer');
    if (consumer === null) return c.json({ error: 'Acknowledgments come from consumers.' }, 403);
    const key = consumerSecret(c.env, consumer, 'HMAC_KEY');
    if (key === undefined) return c.json({ error: `${consumer} has no HMAC key yet.` }, 503);
    // The signature covers the exact bytes sent, so it's checked over them before they're read as
    // text: reading them as text would drop a byte-order mark and replace what isn't UTF-8.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const signature = /^sha256=([0-9a-f]{64})$/u.exec(
      c.req.header('x-spatula-signature') ?? '',
    )?.[1];
    if (signature === undefined || !sameText(signature, await hmacSha256Hex(key, raw))) {
      return c.json({ error: 'The signature is missing or wrong.' }, 401);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
    } catch {
      return c.json({ error: 'The body isn’t UTF-8.' }, 400);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
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
  },
);

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
      sources: (await sourceStates(db, datasetId)).map((state) => ({
        id: state.id,
        blockedRuns: state.blockedRuns,
        refusedAt: state.refusedAt?.toISOString() ?? null,
        lastProbeAt: state.lastProbeAt?.toISOString() ?? null,
        lastProbe: state.lastProbe,
      })),
      verified: verifiedBot(c.env),
    };
  });
  if (status === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json(status);
});

api.get('/datasets/:id/items', async (c) => {
  const datasetId = c.req.param('id');
  // A dataset that isn't there has no items, but an empty list would read as nothing found.
  const items = await withDatabase(c.env, async (db) =>
    (await datasetExists(db, datasetId)) ? listItems(db, datasetId) : null,
  );
  if (items === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json({ items });
});

/** A share, from 0 to 1. */
const share = z.number().min(0).max(1);

// Nine digits at most, so the numbers fit Postgres's integer column, as the snapshot route's do.
const evalSchema = z.strictObject({
  generation: z.number().int().min(1).max(999_999_999),
  goldenVersion: z.number().int().min(1).max(999_999_999),
  // The CLI computes the scores, and the Worker keeps them as they are, checking only their size
  // and the four figures spatula evals shows.
  scores: z.looseObject({
    precision: share,
    recall: share,
    identifiers: z.looseObject({ accuracy: share }),
    keySpecs: z.looseObject({ accuracy: share }),
  }),
});

/** A score is a few kilobytes. The limit bounds what one can store. */
const EVAL_MAX_BYTES = 512 * 1024;

api.post(
  '/datasets/:id/evals',
  bodyLimit({
    maxSize: EVAL_MAX_BYTES,
    onError: (c) => c.json({ error: `The scores are at most ${EVAL_MAX_BYTES / 1024} KiB.` }, 413),
  }),
  async (c) => {
    // Read before it's parsed, as the acknowledgments route reads its body: a body that couldn't be
    // read is a failure, which onError answers and logs, not a body that isn't JSON.
    const text = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'The body isn’t JSON.' }, 400);
    }
    const parsed = evalSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        { error: `The eval is wrong at ${issue?.path.join('.') || 'the body'}: ${issue?.message}` },
        400,
      );
    }
    const datasetId = c.req.param('id');
    // A score doesn't read the dataset's definition, so one that no longer passes the checks doesn't
    // stop it, as it doesn't stop a revival or a question.
    const saved = await withDatabase(c.env, async (db) =>
      (await datasetExists(db, datasetId))
        ? saveEval(db, {
            datasetId,
            generation: parsed.data.generation,
            goldenVersion: parsed.data.goldenVersion,
            scores: parsed.data.scores as unknown as EvalScores,
            at: new Date(),
          })
        : null,
    );
    if (saved === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    return c.json(saved, 201);
  },
);

api.get('/datasets/:id/evals', async (c) => {
  const datasetId = c.req.param('id');
  // A dataset that isn't there has no scores, but an empty list would read as none kept yet.
  const evals = await withDatabase(c.env, async (db) =>
    (await datasetExists(db, datasetId)) ? listEvals(db, datasetId) : null,
  );
  if (evals === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  return c.json({ evals });
});

/*
 * The routes that know who's calling (ADR 0009): the review API's, the taxonomy's, and the
 * proposals' and autonomy's, which a listed consumer's reviewers may call as well as the owner.
 * bearerActor guards every path under them, as the owner guard does under /datasets, so a route
 * added there later knows its caller. A path in CONSUMER_ROUTES skips the owner guard, so it must
 * sit under one of these.
 */
const bearerApi = new Hono<ActorApi>();
const ACTOR_PATHS = [
  '/datasets/:id/review/*',
  '/datasets/:id/taxonomy/*',
  '/datasets/:id/proposals/*',
  '/datasets/:id/autonomy/*',
  // The owner's capture route (ruling 27). Without this, a request to it carries no actor.
  '/datasets/:id/captures/*',
];
for (const path of ACTOR_PATHS) bearerApi.use(path, bearerActor);

/** A seed file is a few dozen kilobytes. The limit bounds what one can store. */
const SEED_MAX_BYTES = 256 * 1024;

/**
 * Seeds a dataset's taxonomy (ADR 0007): version 1, with an ID for every item the file doesn't give
 * one. Once only: after that, the taxonomy changes through proposals. A definition that states its
 * scope must state the seed's. It's the owner's alone, though a consumer's token reaches it.
 */
bearerApi.post(
  '/datasets/:id/taxonomy',
  ownerOnly,
  bodyLimit({
    maxSize: SEED_MAX_BYTES,
    onError: (c) => c.json({ error: `A seed file is at most ${SEED_MAX_BYTES / 1024} KiB.` }, 413),
  }),
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'The body isn’t JSON.' }, 400);
    }
    const parsed = taxonomySeedSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'The taxonomy has problems.',
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`,
          ),
        },
        400,
      );
    }
    const seeded = seedTaxonomy(parsed.data, () => newId('tx'));
    if (!seeded.ok) {
      return c.json({ error: 'The taxonomy has problems.', issues: seeded.issues }, 400);
    }
    const datasetId = c.req.param('id');
    const actor = actorRecord(c.get('actor'));
    const outcome = await withDatabase(c.env, async (db) => {
      const dataset = await getDataset(db, datasetId);
      if (dataset === null) return 'missing' as const;
      const scope = dataset.definition.scope;
      if (scope !== undefined && scope !== parsed.data.scope) return 'scope' as const;
      const current = await currentTaxonomy(db, datasetId);
      if (current !== null) return { exists: current.version };
      const result = await seedTaxonomyVersion(db, {
        datasetId,
        taxonomy: seeded.taxonomy,
        actor,
        at: new Date(),
      });
      return result === 'exists' ? { exists: 1 } : ('seeded' as const);
    });
    if (outcome === 'missing') return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    if (outcome === 'scope') {
      return c.json(
        {
          error: 'The seed’s scope differs from the definition’s. Make them the same, then seed.',
        },
        409,
      );
    }
    if (outcome !== 'seeded') {
      return c.json(
        {
          error: `${datasetId} has a taxonomy already (version ${outcome.exists}). Change it through proposals and the console.`,
        },
        409,
      );
    }
    const { taxonomy } = seeded;
    return c.json(
      {
        version: taxonomy.version,
        shelves: taxonomy.shelves.length,
        functions: taxonomy.functions.length,
        features: taxonomy.features.length,
      },
      201,
    );
  },
);

reviewRoutes(bearerApi);
proposalRoutes(bearerApi);
captureRoutes(bearerApi);

// Hono copies a sub-app's routes when it's mounted, so every route of bearerApi is registered
// above this line.
api.route('/', bearerApi);

/*
 * The console's API (ADR 0009): the datasets, and the review API, for the owner Cloudflare Access
 * signed in. accessActor guards every path under it, a path no route answers included.
 */
const consoleApi = new Hono<ActorApi>();
consoleApi.use('*', accessActor);
consoleApi.get('/datasets', async (c) =>
  c.json({ datasets: await withDatabase(c.env, listDatasets) }),
);
reviewRoutes(consoleApi);
proposalRoutes(consoleApi);
captureRoutes(consoleApi);

// As with bearerApi, every route of consoleApi is registered above this line.
api.route('/console/api', consoleApi);

// The console's own files (ADR 0009). Each of their routes names accessActor, rather than this
// mount using it for all of /console/*, which would check every console API request twice.
api.route('/console', consolePages);

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

/**
 * A run whose row says `running` but whose Workflow can't be found. Just after the row is
 * inserted that is normal: the POST that inserted it is about to create the Workflow. Once
 * RUN_START_GRACE_MS has passed it never will, so the run reads as failed. GET /runs/:id only
 * reports that, like the answer for a Workflow stopped from outside: the row stays as it is until
 * the start of the dataset's next run records the failure, because a run that reads as failed
 * mustn't block its dataset.
 */
function withoutWorkflow(run: RunView, error: unknown): RunView {
  if (Date.now() - Date.parse(run.startedAt) <= RUN_START_GRACE_MS) return run;
  const message = error instanceof Error ? error.message : String(error);
  return { ...run, status: 'failed', error: `Spatula can’t find this run’s Workflow: ${message}` };
}

/** How long ago something began: in whole minutes, and in whole hours from the first hour. */
function ago(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(ms / HOUR_MS);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
}

function describeStop(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error)
    return String(error.message);
  return 'The Workflow stopped before the run finished.';
}
