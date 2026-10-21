import { exportTaxonomy, findItem, type GivenParts } from '@spatula/core';
import {
  createDatabase,
  currentTaxonomy,
  datasetExists,
  listActions,
  listOpenReviews,
  MAX_ACTIONS,
  REVIEW_KINDS,
  type Executor,
} from '@spatula/store';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { actorRecord, limited, needs, ownerOnly, type ActorApi } from './actors';
import { r2Blobs } from './blobs';
import { withDatabase } from './database';
import {
  answerReview,
  answerReviews,
  MAX_BULK,
  suggestAnswers,
  type BulkResult,
  type ReviewPorts,
} from './review';

/*
 * The review API (ADR 0009): the questions waiting, answers to them one at a time or in bulk, the
 * owner's suggestions, the log, and the taxonomy the questions are asked in. The routes don't say
 * who may call them: the app they're registered on knows its callers (bearerActor, accessActor),
 * and each route says what a caller needs. An answer as an older CLI sends it, `{ answer }`, gets
 * the reply and the refusals it always got.
 */

/**
 * The ports the answers use, with one database client for the whole request: a bulk request
 * answers up to MAX_BULK questions, and a client for each use would open hundreds.
 */
function reviewPorts(env: Env): ReviewPorts {
  let db: Executor | undefined;
  return {
    withDb: (fn) => fn((db ??= createDatabase(env.HYPERDRIVE.connectionString, { max: 1 }).db)),
    blobs: r2Blobs(env.STORE),
    now: () => new Date(),
  };
}

/** A taxonomy item, by slug or ID. */
const ref = z.string().min(1).max(64);

/** A taxonomy question's parts, by slug or ID. */
const partsSchema = z.strictObject({
  shelf: ref.optional(),
  functions: z.array(ref).max(64).optional(),
  features: z
    .record(ref, z.array(ref).max(64))
    .refine((features) => Object.keys(features).length <= 64, 'Name at most 64 features.')
    .optional(),
});

const noteSchema = z.string().trim().min(1).max(1000);
const optionSchema = z.string().min(1).max(600);

/** An answer as an older CLI sends it: one of the question's options. */
const answerSchema = z.strictObject({ answer: optionSchema, note: noteSchema.optional() });

/** An answer an older CLI doesn't send: parts, or the question's suggestion. */
const newAnswerSchema = z.union([
  z.strictObject({ parts: partsSchema, note: noteSchema.optional() }),
  z.strictObject({ suggestion: z.literal(true), note: noteSchema.optional() }),
]);

const reviewIdSchema = z.string().min(1).max(100);

const bulkSchema = z.strictObject({
  answers: z
    .array(
      z.union([
        z.strictObject({ reviewId: reviewIdSchema, answer: optionSchema }),
        z.strictObject({ reviewId: reviewIdSchema, parts: partsSchema }),
        z.strictObject({ reviewId: reviewIdSchema, suggestion: z.literal(true) }),
      ]),
    )
    .min(1)
    .max(MAX_BULK),
  note: noteSchema.optional(),
});

const suggestionsSchema = z.strictObject({
  suggestions: z
    .array(z.strictObject({ page: z.string().min(1).max(2048), parts: partsSchema }))
    .min(1)
    .max(MAX_BULK),
});

const listQuery = z.strictObject({
  kind: z.enum(REVIEW_KINDS).optional(),
  shelf: ref.optional(),
  // Source IDs are slugs of up to 63 characters (definition.ts).
  source: z.string().min(1).max(63).optional(),
  below: z.coerce.number().gt(0).max(1).optional(),
});

const logQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_ACTIONS).optional(),
  before: z.iso.datetime().optional(),
});

/** An answer is a few hundred bytes, and a bulk request or a batch of suggestions 500 of them. */
const ANSWER_MAX_BYTES = 64 * 1024;
const BATCH_MAX_BYTES = 1024 * 1024;

const answerLimit = bodyLimit({
  maxSize: ANSWER_MAX_BYTES,
  onError: (c) => c.json({ error: `An answer is at most ${ANSWER_MAX_BYTES / 1024} KiB.` }, 413),
});

const batchLimit = bodyLimit({
  maxSize: BATCH_MAX_BYTES,
  onError: (c) =>
    c.json({ error: `A request is at most ${BATCH_MAX_BYTES / 1024 / 1024} MiB.` }, 413),
});

const NOT_JSON = Symbol('not JSON');

/** The body, read as JSON, or NOT_JSON. */
async function jsonBody(c: Context<ActorApi>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return NOT_JSON;
  }
}

/** What a body or a query got wrong first, and where. */
function wrongAt(what: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.join('.') ?? '';
  return `The ${what} is wrong${path === '' ? '' : ` at ${path}`}: ${issue?.message}`;
}

/** What an answer said, which the reply repeats, as the route always did. */
type Said = { answer: string } | { parts: GivenParts } | { suggestion: true };

function saidOf(sent: Said): Said {
  if ('answer' in sent) return { answer: sent.answer };
  return 'parts' in sent ? { parts: sent.parts } : { suggestion: true };
}

/** The status and body for what became of an answer. */
function answerReply(
  reviewId: string,
  said: Said | Record<string, never>,
  result: BulkResult['result'],
): { status: 200 | 202 | 400 | 403 | 404 | 409 | 500; body: Record<string, unknown> } {
  switch (result.kind) {
    case 'answered':
      return { status: 200, body: { answered: reviewId, ...said, effect: result.effect } };
    case 'flagged':
      return {
        status: 202,
        body: {
          flagged: result.reviewId,
          effect: 'It differs from a person’s answer, so it waits for the owner.',
        },
      };
    case 'missing':
      return { status: 404, body: { error: 'No such question for this dataset.' } };
    case 'closed':
      return { status: 409, body: { error: 'That question has been answered already.' } };
    case 'refused':
      return { status: result.status, body: { error: result.reason } };
    case 'failed':
      // One answer in a bulk request failed, and the others went on, so it's logged here.
      console.error('Review answer failed:', result.error);
      return { status: 500, body: { error: 'Something went wrong. The Worker’s logs say what.' } };
  }
}

/** Registers the review API's routes on an app that knows who's calling. */
export function reviewRoutes(app: Hono<ActorApi>): void {
  // A consumer's reviewers see no flagged question and no publication one (ruling 11), and not
  // the captures questions cite.
  app.get('/datasets/:id/review', needs('review:answer'), async (c) => {
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: wrongAt('query', query.error) }, 400);
    const datasetId = c.req.param('id');
    const { shelf, ...filters } = query.data;
    const forConsumer = c.get('actor').role !== 'owner';
    const reviews = await withDatabase(c.env, async (db) => {
      // A dataset that isn't there has no questions, but an empty list would read as nothing
      // waiting.
      if (!(await datasetExists(db, datasetId))) return 'missing' as const;
      let shelfId: string | undefined;
      if (shelf !== undefined) {
        const current = await currentTaxonomy(db, datasetId);
        shelfId = current === null ? undefined : findItem(current.taxonomy, 'shelf', shelf)?.id;
        if (shelfId === undefined) return 'no shelf' as const;
      }
      return listOpenReviews(db, datasetId, { ...filters, shelf: shelfId, forConsumer });
    });
    if (reviews === 'missing') return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    if (reviews === 'no shelf') {
      return c.json({ error: `${datasetId} has no shelf ${shelf ?? ''}.` }, 400);
    }
    return c.json({ reviews });
  });

  // The paths below are registered before `review/:reviewId`, which would take them for IDs.
  app.post('/datasets/:id/review/bulk', needs('review:answer'), limited, batchLimit, async (c) => {
    const body = await jsonBody(c);
    if (body === NOT_JSON) return c.json({ error: 'The body isn’t JSON.' }, 400);
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: wrongAt('request', parsed.error) }, 400);
    const datasetId = c.req.param('id');
    const ports = reviewPorts(c.env);
    // A dataset that isn't there has no questions, but a 404 for each answer would read as each
    // question missing.
    if (!(await ports.withDb((db) => datasetExists(db, datasetId)))) {
      return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    }
    const results = await answerReviews(ports, {
      datasetId,
      answers: parsed.data.answers,
      note: parsed.data.note,
      actor: actorRecord(c.get('actor')),
    });
    return c.json({
      results: results.map(({ reviewId, result }) => {
        const reply = answerReply(reviewId, {}, result);
        return { reviewId, status: reply.status, ...reply.body };
      }),
    });
  });

  app.post('/datasets/:id/review/suggestions', ownerOnly, limited, batchLimit, async (c) => {
    const body = await jsonBody(c);
    if (body === NOT_JSON) return c.json({ error: 'The body isn’t JSON.' }, 400);
    const parsed = suggestionsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: wrongAt('request', parsed.error) }, 400);
    const datasetId = c.req.param('id');
    const ports = reviewPorts(c.env);
    if (!(await ports.withDb((db) => datasetExists(db, datasetId)))) {
      return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    }
    const results = await suggestAnswers(ports, {
      datasetId,
      suggestions: parsed.data.suggestions,
      actor: actorRecord(c.get('actor')),
    });
    return c.json({
      suggestions: results.map((result) => {
        switch (result.kind) {
          case 'suggested':
            return { page: result.page, status: 200, reviewId: result.reviewId };
          case 'missing':
            return { page: result.page, status: 404, error: 'No open question about this page.' };
          case 'refused':
            return { page: result.page, status: 400, error: result.reason };
        }
      }),
    });
  });

  app.get('/datasets/:id/review/log', ownerOnly, async (c) => {
    const query = logQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: wrongAt('query', query.error) }, 400);
    const datasetId = c.req.param('id');
    const { limit, before } = query.data;
    const actions = await withDatabase(c.env, async (db) =>
      (await datasetExists(db, datasetId))
        ? listActions(db, datasetId, {
            limit,
            before: before === undefined ? undefined : new Date(before),
          })
        : null,
    );
    if (actions === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    return c.json({ actions });
  });

  app.post(
    '/datasets/:id/review/:reviewId',
    needs('review:answer'),
    limited,
    answerLimit,
    async (c) => {
      const body = await jsonBody(c);
      if (body === NOT_JSON) return c.json({ error: 'The body isn’t JSON.' }, 400);
      let sent: Said & { note?: string };
      // A body with parts or a suggestion is the review API's own. Any other is an answer as an
      // older CLI sends it, refused in the words that CLI knows.
      if (typeof body === 'object' && body !== null && ('parts' in body || 'suggestion' in body)) {
        const parsed = newAnswerSchema.safeParse(body);
        if (!parsed.success) return c.json({ error: wrongAt('answer', parsed.error) }, 400);
        sent = parsed.data;
      } else {
        const parsed = answerSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: 'Send { "answer": one of the question’s options }.' }, 400);
        }
        sent = parsed.data;
      }
      const reviewId = c.req.param('reviewId');
      const said = saidOf(sent);
      const result = await answerReview(reviewPorts(c.env), {
        datasetId: c.req.param('id'),
        reviewId,
        ...said,
        note: sent.note,
        actor: actorRecord(c.get('actor')),
      });
      const reply = answerReply(reviewId, said, result);
      return c.json(reply.body, reply.status);
    },
  );

  /** The dataset's current taxonomy, whole, or in the seed file's shape with `?format=export`. */
  app.get('/datasets/:id/taxonomy', needs('review:answer'), async (c) => {
    const format = c.req.query('format');
    if (format !== undefined && format !== 'export') {
      return c.json({ error: 'format is export, or left out.' }, 400);
    }
    const datasetId = c.req.param('id');
    const found = await withDatabase(c.env, async (db) =>
      (await datasetExists(db, datasetId))
        ? { current: await currentTaxonomy(db, datasetId) }
        : null,
    );
    if (found === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    if (found.current === null) return c.json({ error: `${datasetId} has no taxonomy yet.` }, 404);
    const { version, taxonomy } = found.current;
    return c.json(
      format === 'export' ? { version, export: exportTaxonomy(taxonomy) } : { version, taxonomy },
    );
  });
}
