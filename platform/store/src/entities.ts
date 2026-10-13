import {
  identityClaims,
  MAX_MATCH_QUESTIONS,
  mergeValues,
  nameScope,
  newId,
  planMatch,
  survivingValues,
  type Definition,
  type FieldValue,
  type MatchVerdict,
  type RecordType,
} from '@spatula/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from './client';
import { judgementsFor } from './decisions';
import { entities, entityKeys, items } from './schema';
import { currentStatements, statementsOf, type CurrentStatement } from './statements';

export interface EntityResolution {
  created: number;
  /** Pages newly joined to an entity that already existed. */
  linked: number;
  conflicts: number;
  unresolved: number;
  /** Pages waiting for a match question to be asked or answered. */
  waiting: number;
  /** The match questions to ask: a page, and an entity it may belong to. */
  questions: { itemId: string; entityId: string }[];
  notes: string[];
}

/**
 * Joins each live page to the entity it describes. Pages already joined claim their keys first,
 * so a new page finds them. A page that isn't joined yet follows its match plan: it joins on an
 * identifier, or on a name that no identifier contradicts; it starts a new entity, with a canonical
 * ID assigned once; or it waits for a question about an entity to be asked and answered. A claim
 * another entity already owns is reported as a conflict and changes nothing, unless a verdict says
 * the two aren't the same.
 *
 * A pair that was escalated when no decider could be asked is recorded as unsure "by rule". While
 * `deciderCanAnswer` is false that waits for a person, like any unsure verdict. Once it is true,
 * the pair is a question again, so it is asked now that something can answer it. A decider's own
 * "unsure" and a person's are answers, and still wait for a person.
 */
export async function resolveEntities(
  db: Executor,
  input: {
    datasetId: string;
    definition: Definition;
    /** The most questions to raise. The pages with no room for theirs wait for the next run. */
    maxQuestions?: number;
    /** Whether a decider can be asked a match question: one is set up, and the dataset allows it. */
    deciderCanAnswer?: boolean;
  },
): Promise<EntityResolution> {
  const { datasetId, definition } = input;
  const maxQuestions = input.maxQuestions ?? MAX_MATCH_QUESTIONS;
  const deciderCanAnswer = input.deciderCanAnswer ?? false;
  return db.transaction(async (tx) => {
    // Pushed in place: copying each item's list for every statement would be quadratic.
    const said = new Map<string, CurrentStatement[]>();
    for (const statement of await currentStatements(tx, datasetId)) {
      const list = said.get(statement.itemId);
      if (list === undefined) said.set(statement.itemId, [statement]);
      else list.push(statement);
    }
    const pages = await tx
      .select({
        id: items.id,
        locator: items.locator,
        recordType: items.recordType,
        entityId: items.entityId,
      })
      .from(items)
      .where(and(eq(items.datasetId, datasetId), eq(items.status, 'live')))
      .orderBy(asc(items.sourceId), asc(items.locator));
    const owners = new Map(
      (
        await tx
          .select({ value: entityKeys.value, entityId: entityKeys.entityId })
          .from(entityKeys)
          .where(eq(entityKeys.datasetId, datasetId))
      ).map((key) => [key.value, key.entityId]),
    );
    const verdicts = new Map<string, Map<string, MatchVerdict>>();
    for (const judgement of await judgementsFor(tx, datasetId)) {
      // "Unsure by rule" means no decider was asked. It is no answer once one can be.
      if (deciderCanAnswer && judgement.verdict === 'unsure' && judgement.who === 'rule') continue;
      const own = verdicts.get(judgement.itemId) ?? new Map<string, MatchVerdict>();
      own.set(judgement.entityId, judgement.verdict);
      verdicts.set(judgement.itemId, own);
    }

    // What each entity's pages give as identifiers, and its names by scope, as pages join.
    const identifiers = new Map<string, Record<string, FieldValue[]>>();
    const byScope = new Map<string, Map<string, string[]>>();
    const remember = (
      entityId: string,
      recordType: RecordType,
      values: Record<string, FieldValue[]>,
    ) => {
      const own = identifiers.get(entityId) ?? {};
      mergeValues(
        own,
        Object.fromEntries(
          recordType.identity.identifiers.map((name) => [name, values[name] ?? []]),
        ),
      );
      identifiers.set(entityId, own);
      const named = nameScope(recordType, values);
      if (named === null) return;
      const scope = byScope.get(named.scope) ?? new Map<string, string[]>();
      scope.set(entityId, [...(scope.get(entityId) ?? []), named.name]);
      byScope.set(named.scope, scope);
    };
    const valuesOf = (page: (typeof pages)[number], recordType: RecordType) =>
      survivingValues(recordType, said.get(page.id) ?? []);
    for (const page of pages) {
      const recordType = definition.recordTypes[page.recordType];
      if (page.entityId !== null && recordType !== undefined) {
        remember(page.entityId, recordType, valuesOf(page, recordType));
      }
    }

    const result: EntityResolution = {
      created: 0,
      linked: 0,
      conflicts: 0,
      unresolved: 0,
      waiting: 0,
      questions: [],
      notes: [],
    };
    const joined = pages.filter((page) => page.entityId !== null);
    const unjoined = pages.filter((page) => page.entityId === null);
    for (const page of [...joined, ...unjoined]) {
      const recordType = definition.recordTypes[page.recordType];
      if (recordType === undefined) continue;
      const values = valuesOf(page, recordType);
      const pageVerdicts = verdicts.get(page.id) ?? new Map<string, MatchVerdict>();

      let entityId = page.entityId;
      if (entityId === null) {
        const named = nameScope(recordType, values);
        const plan = planMatch({
          recordType,
          values,
          owners,
          identifiers,
          sameScope: [...(byScope.get(named?.scope ?? '') ?? new Map<string, string[]>())].map(
            ([id, names]) => ({ id, names }),
          ),
          verdicts: pageVerdicts,
        });
        if (plan.kind === 'unresolvable') {
          result.unresolved += 1;
          result.notes.push(
            `${page.locator} has nothing to identify it by yet, so it has no entity`,
          );
          continue;
        }
        if (plan.kind === 'wait' || plan.kind === 'ask') {
          result.waiting += 1;
          if (plan.kind === 'ask') {
            for (const candidate of plan.entityIds) {
              if (result.questions.length < maxQuestions) {
                result.questions.push({ itemId: page.id, entityId: candidate });
              }
            }
          }
          continue;
        }
        if (plan.kind === 'join') {
          entityId = plan.entityId;
          result.linked += 1;
        } else {
          entityId = newId('sp');
          await tx
            .insert(entities)
            .values({ id: entityId, datasetId, recordType: page.recordType });
          result.created += 1;
        }
        await tx.update(items).set({ entityId }).where(eq(items.id, page.id));
        remember(entityId, recordType, values);
      }

      for (const claim of identityClaims(recordType, values)) {
        const owner = owners.get(claim.value);
        if (owner === undefined) {
          owners.set(claim.value, entityId);
          await tx.insert(entityKeys).values({ datasetId, value: claim.value, entityId });
        } else if (owner !== entityId && pageVerdicts.get(owner) !== 'not_same') {
          result.conflicts += 1;
          result.notes.push(
            `${page.locator} claims ${claim.value}, which belongs to ${owner}, while the page belongs to ${entityId}`,
          );
        }
      }
    }
    return result;
  });
}

export interface MatchSides {
  /** The page's record type, whose pack says what "same" means. */
  recordType: string;
  page: { url: string; values: Record<string, FieldValue[]> };
  entity: { url: string; values: Record<string, FieldValue[]> };
  /** The entity's live pages, whose sites' consent the question needs too. */
  entityItemIds: string[];
}

/** At most this many values of each field go into a question's state. */
const SIDE_VALUES_MAX = 20;

/**
 * A match question's two sides: the page's surviving values, and the entity's, merged from its live
 * pages. Null when the page isn't live or the entity has no live page.
 */
export async function matchSides(
  db: Executor,
  input: { definition: Definition; itemId: string; entityId: string },
): Promise<MatchSides | null> {
  const [page] = await db
    .select({ id: items.id, locator: items.locator, recordType: items.recordType })
    .from(items)
    .where(and(eq(items.id, input.itemId), eq(items.status, 'live')));
  const members = await db
    .select({ id: items.id, locator: items.locator })
    .from(items)
    .where(and(eq(items.entityId, input.entityId), eq(items.status, 'live')))
    .orderBy(asc(items.locator));
  const recordType = page === undefined ? undefined : input.definition.recordTypes[page.recordType];
  if (page === undefined || recordType === undefined || members.length === 0) return null;
  const said = await statementsOf(db, [page.id, ...members.map((member) => member.id)]);
  const capped = (values: Record<string, FieldValue[]>) =>
    Object.fromEntries(
      Object.entries(values).map(([name, list]) => [name, list.slice(0, SIDE_VALUES_MAX)]),
    );
  const theirs: Record<string, FieldValue[]> = {};
  for (const member of members) {
    mergeValues(theirs, survivingValues(recordType, said.get(member.id) ?? []));
  }
  return {
    recordType: page.recordType,
    page: {
      url: page.locator,
      values: capped(survivingValues(recordType, said.get(page.id) ?? [])),
    },
    entity: { url: members[0]!.locator, values: capped(theirs) },
    entityItemIds: members.map((member) => member.id),
  };
}
