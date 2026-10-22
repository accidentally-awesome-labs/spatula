import {
  ADDITIVE_KINDS,
  AUTONOMY_AFTER,
  CHANGE_KINDS,
  changeSchema,
  EARNABLE_KINDS,
  newId,
  storableChange,
  type ProposableChange,
} from '@spatula/core';
import {
  autonomyOf,
  datasetExists,
  decideProposal,
  getProposal,
  listProposals,
  logAction,
  PROPOSAL_STATUSES,
  revokeAutonomy,
  SCOPE_REFUSAL,
  taxonomyHistory,
  undoVersion,
  type ProposalRow,
  type ProposalStatus,
} from '@spatula/store';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { actorRecord, limited, needs, ownerOnly, type ActorApi } from './actors';
import { withDatabase } from './database';
import { noteSchema } from './text';

/*
 * The taxonomy's proposals, versions, and autonomy (ADR 0007, ADR 0009), registered on the bearer
 * app and under /console/api, as the review routes are. The owner decides every proposal. A
 * consumer's reviewer with taxonomy:approve-additive lists the additive kinds and accepts or
 * rejects them, and its approvals count toward their autonomy. Versions, undo, and autonomy are
 * the owner's. Every write is logged in the transaction that makes it.
 */

/** A decision's body: a change and a note come to a few kilobytes at most. */
const DECISION_MAX_BYTES = 64 * 1024;

const decisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('accept'), note: noteSchema.optional() }),
  z.strictObject({ decision: z.literal('reject'), note: noteSchema.optional() }),
  z.strictObject({ decision: z.literal('edit'), change: z.unknown(), note: noteSchema.optional() }),
]);

const isStatus = (text: string): text is ProposalStatus =>
  (PROPOSAL_STATUSES as readonly string[]).includes(text);
const isAdditive = (kind: string) => (ADDITIVE_KINDS as readonly string[]).includes(kind);

/**
 * A proposal as a consumer's reviewer sees it: the change and what it would do. Its evidence and
 * the review's reasons carry page text, which no consumer route carries.
 */
function forConsumer(row: ProposalRow) {
  return {
    id: row.id,
    kind: row.kind,
    change: row.change,
    summary: row.summary,
    impact: row.impact,
    status: row.status,
    base: row.base,
    version: row.version,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

export function proposalRoutes(app: Hono<ActorApi>): void {
  app.get('/datasets/:id/proposals', needs('taxonomy:approve-additive'), async (c) => {
    const status = c.req.query('status');
    if (status !== undefined && !isStatus(status)) {
      return c.json({ error: `status is one of ${PROPOSAL_STATUSES.join(', ')}.` }, 400);
    }
    const datasetId = c.req.param('id');
    const rows = await withDatabase(c.env, async (db) =>
      (await datasetExists(db, datasetId))
        ? listProposals(db, datasetId, status === undefined ? {} : { status })
        : null,
    );
    if (rows === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    if (c.get('actor').role === 'owner') return c.json({ proposals: rows });
    // A dropped proposal's text is the review's, unchecked, so it stays the owner's too.
    return c.json({
      proposals: rows
        .filter((row) => row.status !== 'dropped' && isAdditive(row.kind))
        .map(forConsumer),
    });
  });

  app.post(
    '/datasets/:id/proposals/:proposalId',
    needs('taxonomy:approve-additive'),
    limited,
    bodyLimit({
      maxSize: DECISION_MAX_BYTES,
      onError: (c) =>
        c.json({ error: `A decision is at most ${DECISION_MAX_BYTES / 1024} KiB.` }, 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'The body isn’t JSON.' }, 400);
      }
      const parsed = decisionSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error:
              'Send { "decision": "accept" } or { "decision": "reject" }, or { "decision": "edit", "change": the change }, each with a note if you like.',
          },
          400,
        );
      }
      const decided = parsed.data;
      const actor = c.get('actor');
      if (decided.decision === 'edit' && actor.role !== 'owner') {
        return c.json({ error: 'Only the owner edits a proposal.' }, 403);
      }
      let change: ProposableChange | undefined;
      if (decided.decision === 'edit') {
        const checked = changeSchema.safeParse(decided.change);
        if (!checked.success) {
          return c.json(
            {
              error: 'The change isn’t one Spatula takes.',
              issues: checked.error.issues.map(
                (issue) => `${issue.path.join('.')}: ${issue.message}`,
              ),
            },
            400,
          );
        }
        if (!storableChange(checked.data)) {
          return c.json({ error: 'The change holds control characters.' }, 400);
        }
        if (checked.data.kind === 'scope') return c.json({ error: SCOPE_REFUSAL }, 400);
        change = checked.data;
      }
      const datasetId = c.req.param('id');
      const proposalId = c.req.param('proposalId');
      const record = actorRecord(actor);
      const result = await withDatabase(c.env, async (db) => {
        const proposal = await getProposal(db, proposalId);
        if (proposal === null || proposal.datasetId !== datasetId) {
          return { kind: 'missing' as const };
        }
        // What an edit turns the proposal into is what gets applied, so the actor's right is
        // checked against that kind as well as the proposal's.
        const kinds = change === undefined ? [proposal.kind] : [proposal.kind, change.kind];
        const refused = kinds.find((kind) => actor.role !== 'owner' && !isAdditive(kind));
        if (refused !== undefined) return { kind: 'forbidden' as const, about: refused };
        const at = new Date();
        return db.transaction(async (tx) => {
          const outcome = await decideProposal(tx, {
            id: proposalId,
            decision: decided.decision,
            ...(change === undefined ? {} : { change }),
            actor: record,
            note: decided.note ?? null,
            makeId: () => newId('tx'),
            at,
          });
          if (outcome.kind !== 'stale') {
            await logAction(tx, {
              datasetId,
              action: decided.decision,
              subject: proposalId,
              actor: record,
              detail: {
                kind: proposal.kind,
                ...(outcome.kind === 'applied'
                  ? { version: outcome.version, summary: outcome.summary }
                  : {}),
                ...(change === undefined ? {} : { change }),
                ...(decided.note === undefined ? {} : { note: decided.note }),
              },
              at,
            });
          }
          return outcome;
        });
      });
      switch (result.kind) {
        case 'missing':
          return c.json({ error: 'No such proposal for this dataset.' }, 404);
        case 'forbidden':
          return c.json({ error: `Only the owner decides ${result.about} proposals.` }, 403);
        case 'stale':
          return c.json({ error: result.reason }, 409);
        case 'rejected':
          return c.json({ proposal: proposalId, status: 'rejected' });
        case 'applied':
          return c.json({
            proposal: proposalId,
            status: 'applied',
            version: result.version,
            summary: result.summary,
          });
      }
    },
  );

  app.get('/datasets/:id/taxonomy/versions', ownerOnly, async (c) => {
    const datasetId = c.req.param('id');
    const versions = await withDatabase(c.env, async (db) =>
      (await datasetExists(db, datasetId)) ? taxonomyHistory(db, datasetId) : null,
    );
    if (versions === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    return c.json({ versions });
  });

  app.post('/datasets/:id/taxonomy/versions/:version/undo', ownerOnly, limited, async (c) => {
    const text = c.req.param('version');
    // As a snapshot's generation is read: digits from 1, at most nine, so Postgres takes it.
    if (!/^[1-9]\d{0,8}$/u.test(text)) {
      return c.json({ error: 'A version is a whole number from 1.' }, 400);
    }
    const version = Number(text);
    const datasetId = c.req.param('id');
    const record = actorRecord(c.get('actor'));
    const result = await withDatabase(c.env, async (db) => {
      if (!(await datasetExists(db, datasetId))) return { kind: 'missing' as const };
      const at = new Date();
      return db.transaction(async (tx) => {
        const undone = await undoVersion(tx, {
          datasetId,
          version,
          actor: record,
          makeId: () => newId('tx'),
          at,
        });
        if (undone.kind === 'undone') {
          await logAction(tx, {
            datasetId,
            action: 'undo',
            subject: `version:${version}`,
            actor: record,
            detail: { version: undone.version, summary: undone.summary, revoked: undone.revoked },
            at,
          });
        }
        return undone;
      });
    });
    switch (result.kind) {
      case 'missing':
        return c.json({ error: `${datasetId} has no taxonomy version ${version}.` }, 404);
      case 'refused':
        return c.json({ error: result.reason }, 409);
      case 'undone':
        return c.json({
          undone: version,
          version: result.version,
          summary: result.summary,
          revoked: result.revoked,
        });
    }
  });

  app.get('/datasets/:id/autonomy', ownerOnly, async (c) => {
    const datasetId = c.req.param('id');
    const kinds = await withDatabase(c.env, async (db) =>
      (await datasetExists(db, datasetId)) ? autonomyOf(db, datasetId) : null,
    );
    if (kinds === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    return c.json({ after: AUTONOMY_AFTER, kinds });
  });

  app.post('/datasets/:id/autonomy/:kind/revoke', ownerOnly, limited, async (c) => {
    const kind = c.req.param('kind');
    if (!(CHANGE_KINDS as readonly string[]).includes(kind)) {
      return c.json({ error: 'There’s no such kind of change.' }, 404);
    }
    // Only an earnable kind has a run to revoke: the table's CHECK refuses any other.
    const earnable = EARNABLE_KINDS.find((candidate) => candidate === kind);
    if (earnable === undefined) {
      return c.json(
        {
          error: `${kind} never applies on its own: it’s always the owner’s, so there’s nothing to revoke.`,
        },
        400,
      );
    }
    const datasetId = c.req.param('id');
    const record = actorRecord(c.get('actor'));
    const was = await withDatabase(c.env, async (db) => {
      if (!(await datasetExists(db, datasetId))) return null;
      const at = new Date();
      return db.transaction(async (tx) => {
        const streak = await revokeAutonomy(tx, { datasetId, kind: earnable, at });
        await logAction(tx, {
          datasetId,
          action: 'revoke',
          subject: `autonomy:${earnable}`,
          actor: record,
          detail: { was: streak },
          at,
        });
        return streak;
      });
    });
    if (was === null) return c.json({ error: `Dataset ${datasetId} doesn’t exist.` }, 404);
    return c.json({ kind: earnable, streak: 0, was });
  });
}
