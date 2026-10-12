import { packIssues, parseDefinition, runIdFor, sha256Hex, type RunView } from '@spatula/core';
import { packs } from '@spatula/pack-products';
import {
  applyDefinition,
  datasetExists,
  finishRun,
  getDataset,
  getRun,
  getSnapshot,
  latestSnapshot,
  reviveItems,
  StaleDefinitionError,
  startRun,
} from '@spatula/store';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { aboutPage } from './about';
import { secret } from './config';
import { withDatabase } from './database';

/*
 * The owner's API, and the public page. The owner sends a bearer token; the Worker keeps only its
 * SHA-256 and compares in constant time. Owner answers are personal, so nothing caches them, and
 * the same goes for every other answer but the page: an unknown path's 404 and a failure's 500.
 */

type Api = { Bindings: Env };

/**
 * Every answer but the public page carries this. The owner middleware, notFound and onError set
 * it with c.header, which Hono copies into the responses it builds (c.json). A handler that
 * returns a raw Response has to set it by hand, as the snapshot route does.
 */
const PRIVATE_NO_STORE = 'private, no-store';

export const api = new Hono<Api>();

api.get('/', (c) => c.html(aboutPage(c.env)));

const owner: MiddlewareHandler<Api> = async (c, next) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  const expected = secret(c.env, 'OWNER_TOKEN_HASH');
  if (expected === undefined)
    return c.json({ error: 'This deployment has no owner token yet.' }, 503);
  // RFC 9110 makes an authentication scheme's name case-insensitive. The token is not: the flag
  // applies to the word "bearer" only, and the group keeps the token as it was sent.
  const token = /^bearer (.+)$/iu.exec(c.req.header('authorization') ?? '')?.[1];
  if (token === undefined || !sameText(await sha256Hex(token), expected.toLowerCase())) {
    c.header('www-authenticate', 'Bearer');
    return c.json({ error: 'The owner token is missing or wrong.' }, 401);
  }
  await next();
};
api.use('/datasets/*', owner);
api.use('/runs/*', owner);

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
  const runId = runIdFor(datasetId, new Date());
  // The run is recorded first, so its ID can be reported at once, and a second request in the
  // same five-minute slot finds it.
  const started = await withDatabase(c.env, async (db) => {
    try {
      if ((await getDataset(db, datasetId)) === null) return 'missing';
    } catch (error) {
      // A definition stored by an earlier version that no longer passes the checks. The owner fixes
      // it by applying the definition again, and the error says so.
      if (error instanceof StaleDefinitionError) return error;
      throw error;
    }
    return (await startRun(db, { id: runId, datasetId })).created ? 'started' : 'exists';
  });
  if (started === 'missing') return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
  if (started instanceof StaleDefinitionError) return c.json({ error: started.message }, 409);
  if (started === 'exists') {
    return c.json({ error: 'A run already started in this five-minute slot.', runId }, 409);
  }
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

api.get('/datasets/:id/snapshots/:generation', async (c) => {
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

// These two answer whatever the path, including ones outside the owner routes, which set the
// header themselves.
api.notFound((c) => {
  c.header('cache-control', PRIVATE_NO_STORE);
  return c.json({ error: 'Not found.' }, 404);
});

api.onError((error, c) => {
  console.error('API error:', error instanceof Error ? error.message : String(error));
  c.header('cache-control', PRIVATE_NO_STORE);
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
