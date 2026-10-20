import {
  basePages,
  claimLabel,
  contestedNames,
  editionsOf,
  identityClaims,
  lineupOf,
  MAX_LINEUP,
  MAX_MATCH_QUESTIONS,
  mergeValues,
  nameField,
  nameScope,
  newId,
  planMatch,
  survivingValues,
  type Definition,
  type EntityMember,
  type FieldValue,
  type LineupEntry,
  type MatchVerdict,
  type RecordType,
} from '@spatula/core';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Executor } from './client';
import { judgementsFor } from './decisions';
import { pagesRefusingAiInput } from './fetches';
import { entities, entityKeys, items, judgements } from './schema';
import { currentStatements, statementsOf, type CurrentStatement } from './statements';

export interface EntityResolution {
  created: number;
  /** Pages newly joined to an entity that already existed. */
  linked: number;
  conflicts: number;
  unresolved: number;
  /**
   * Pages waiting for a match question to be asked or answered, for it to be settled which
   * entities carry their name, or because their "same" verdicts contradict each other.
   */
  waiting: number;
  /** The match questions to ask: a page, and an entity it may belong to. */
  questions: { itemId: string; entityId: string }[];
  /**
   * What each question shows beside it (ADR 0003): the other records in the page's scope, closest
   * by name first, by question as `itemId|entityId`. Only the questions above that have one are
   * listed, and a record with a page whose site refuses AI input is never one of them. It is
   * evidence, and never part of a question's key. A resolution kept by an earlier version has none.
   */
  lineups?: Record<string, LineupEntry[]>;
  notes: string[];
}

/**
 * Joins each live page to the entity it describes. Pages already joined claim their keys first,
 * so a new page finds them. The pages that aren't joined yet follow, each group ahead of the pages
 * that have to see where it lands: first those that give an identifier, since joining by one makes
 * an entity carry the page's name too; then those that give only a name and have a "same" or "not
 * the same" verdict, since those place a page ("same" joins the entity it was judged the same as,
 * a person's or a decider's lone one; "not the same" keeps it apart, so it starts an entity or
 * joins another); and last those that give only a name and have no such verdict, an "unsure" one
 * included, since that places nothing. A page follows its match plan: it joins on an identifier,
 * or on a name that no identifier contradicts and no other entity shares; it starts a new entity,
 * with a canonical ID assigned once; or it waits for a question about an entity to be asked and
 * answered.
 *
 * Each question comes with its lineup: the other records in the page's scope, closest by name to
 * the page first, marking those a person kept apart from the record asked about (`lineupOf`). A
 * lineup shows other records' names to a decider, so it leaves out any record that has a page whose
 * site refuses AI input.
 *
 * A page that gives only a name waits too, whichever pages sort before it, while its name is
 * contested (`contestedNames`, worked out from where the pass begins): the pages that give
 * identifiers under it disagree, or a person has yet to say whether a page of that name is an
 * entity's. A note says how many pages wait on each such name. Once the contest settles the page
 * follows the plan above.
 *
 * Several "same" verdicts about a page join it to none of those entities, and a note says so,
 * unless exactly one is a person's: the page joins that entity. A decider's lone "same" beside a
 * question that waits for a person waits for that question.
 *
 * A claim another entity already owns is reported as a conflict and changes nothing. The
 * exception is a name that two entities share once their pages have been judged not the same:
 * that is what a "spec-version" answer leaves. A GTIN or part number two entities claim is always a
 * conflict.
 *
 * A pair that was escalated when no decider could be asked is recorded as unsure "by rule". While
 * `deciderCanAnswer` is false that waits for a person, like any unsure verdict. Once it is true,
 * the pair is a question again, so it is asked now that something can answer it, after the
 * questions nobody has asked yet when there is room for only some. A decider's own "unsure" and a
 * person's are answers, and still wait for a person.
 */
export async function resolveEntities(
  db: Executor,
  input: {
    datasetId: string;
    definition: Definition;
    /**
     * The most questions to raise. The pages with no room for theirs wait for the next run.
     */
    maxQuestions?: number;
    /**
     * Whether a decider can be asked a match question: one is set up, and the dataset allows it.
     */
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
    const byPerson = new Map<string, Set<string>>();
    const pairOf = (itemId: string, entityId: string) => `${itemId}|${entityId}`;
    const askedAgain = new Set<string>();
    for (const judgement of await judgementsFor(tx, datasetId)) {
      // "Unsure by rule" means no decider was asked. It is no answer once one can be.
      if (deciderCanAnswer && judgement.verdict === 'unsure' && judgement.who === 'rule') {
        askedAgain.add(pairOf(judgement.itemId, judgement.entityId));
        continue;
      }
      const own = verdicts.get(judgement.itemId) ?? new Map<string, MatchVerdict>();
      own.set(judgement.entityId, judgement.verdict);
      verdicts.set(judgement.itemId, own);
      if (judgement.who === 'person') {
        const theirs = byPerson.get(judgement.itemId) ?? new Set<string>();
        byPerson.set(judgement.itemId, theirs.add(judgement.entityId));
      }
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
    // The entities kept apart: a page that belongs to one was judged not the same as the other.
    // Those a person kept apart are marked so in a question's lineup.
    const keptApart = new Map<string, Set<string>>();
    const apartByPerson = new Map<string, Set<string>>();
    const keepApart = (
      entityId: string,
      pageId: string,
      pageVerdicts: ReadonlyMap<string, MatchVerdict>,
    ) => {
      for (const [other, verdict] of pageVerdicts) {
        if (verdict !== 'not_same' || other === entityId) continue;
        keptApart.set(entityId, (keptApart.get(entityId) ?? new Set<string>()).add(other));
        keptApart.set(other, (keptApart.get(other) ?? new Set<string>()).add(entityId));
        if (byPerson.get(pageId)?.has(other) !== true) continue;
        apartByPerson.set(entityId, (apartByPerson.get(entityId) ?? new Set<string>()).add(other));
        apartByPerson.set(other, (apartByPerson.get(other) ?? new Set<string>()).add(entityId));
      }
    };
    // The entities with a page whose site refuses AI input, which no lineup may show: what a
    // lineup shows of a record is its pages' names, and a decider's evidence needs the consent of
    // every site it shows (ADR 0003).
    const refusing = await pagesRefusingAiInput(tx, datasetId);
    const refusingEntities = new Set<string>();
    const noteConsent = (entityId: string, pageId: string) => {
      if (refusing.has(pageId)) refusingEntities.add(entityId);
    };
    for (const page of pages) {
      const recordType = definition.recordTypes[page.recordType];
      if (page.entityId !== null && recordType !== undefined) {
        remember(page.entityId, recordType, valuesOf(page, recordType));
        noteConsent(page.entityId, page.id);
        keepApart(page.entityId, page.id, verdicts.get(page.id) ?? new Map<string, MatchVerdict>());
      }
    }
    // The names whose entities the pages that give identifiers are still sorting out. They are
    // worked out from the pages not joined yet as the pass begins, so that what a page does about
    // its name doesn't depend on which pages sort before it.
    const contested = new Set<string>();
    for (const [typeName, recordType] of Object.entries(definition.recordTypes)) {
      const unjoinedOfType = pages.filter(
        (page) => page.entityId === null && page.recordType === typeName,
      );
      for (const name of contestedNames({
        recordType,
        pages: unjoinedOfType.map((page) => ({
          values: valuesOf(page, recordType),
          verdicts: verdicts.get(page.id) ?? new Map<string, MatchVerdict>(),
        })),
        owners,
        identifiers,
      })) {
        contested.add(name);
      }
    }

    const result: EntityResolution = {
      created: 0,
      linked: 0,
      conflicts: 0,
      unresolved: 0,
      waiting: 0,
      questions: [],
      lineups: {},
      notes: [],
    };
    const fresh: EntityResolution['questions'] = [];
    const again: EntityResolution['questions'] = [];
    const lineups = new Map<string, LineupEntry[]>();
    // The pages held on a contested name, by name, with the words of the first.
    const held = new Map<string, { label: string; pages: number }>();
    const joined = pages.filter((page) => page.entityId !== null);
    const unjoined = pages.filter((page) => page.entityId === null);
    // The pages that aren't joined yet go in three groups, each ahead of the pages that have to see
    // where it lands. A page that joins an entity by an identifier makes that entity carry its name
    // too, and a page that gives only a name has to see that before it joins the entity that
    // carried the name first. Among the pages that give only a name, a "same" or "not the same"
    // verdict places a page: "same" joins the entity it was judged the same as, whether a person's
    // or a decider's lone one, and "not the same" keeps the page apart, so that it starts an entity
    // or joins another, which then carries the name. "Unsure" places nothing. A page with no such
    // verdict has to see where those land.
    const givesIdentifier = (page: (typeof pages)[number]) => {
      const recordType = definition.recordTypes[page.recordType];
      return (
        recordType !== undefined &&
        identityClaims(recordType, valuesOf(page, recordType)).some(
          (claim) => claim.rank < recordType.identity.identifiers.length,
        )
      );
    };
    const identified = unjoined.filter(givesIdentifier);
    const nameOnly = unjoined.filter((page) => !givesIdentifier(page));
    const placedByVerdict = (page: (typeof pages)[number]) =>
      [...(verdicts.get(page.id)?.values() ?? [])].some((verdict) => verdict !== 'unsure');
    const placed = nameOnly.filter(placedByVerdict);
    const unplaced = nameOnly.filter((page) => !placedByVerdict(page));
    for (const page of [...joined, ...identified, ...placed, ...unplaced]) {
      const recordType = definition.recordTypes[page.recordType];
      if (recordType === undefined) continue;
      const values = valuesOf(page, recordType);
      const pageVerdicts = verdicts.get(page.id) ?? new Map<string, MatchVerdict>();

      let entityId = page.entityId;
      if (entityId === null) {
        const named = nameScope(recordType, values);
        const sameScope = [...(byScope.get(named?.scope ?? '') ?? new Map<string, string[]>())].map(
          ([id, names]) => ({ id, names }),
        );
        const plan = planMatch({
          recordType,
          values,
          owners,
          identifiers,
          sameScope,
          verdicts: pageVerdicts,
          byPerson: byPerson.get(page.id) ?? new Set<string>(),
          contested,
        });
        if (plan.kind === 'unresolvable') {
          result.unresolved += 1;
          result.notes.push(
            `${page.locator} has nothing to identify it by yet, so it has no entity`,
          );
          continue;
        }
        if (plan.kind === 'hold') {
          result.waiting += 1;
          const on = held.get(plan.name) ?? {
            label: claimLabel(recordType, values, plan.name) ?? plan.name,
            pages: 0,
          };
          held.set(plan.name, { ...on, pages: on.pages + 1 });
          continue;
        }
        if (plan.kind === 'dispute') {
          // The note states the fact. Nothing here asks anyone to settle it.
          result.waiting += 1;
          const joins = plan.entityIds.length === 2 ? 'neither' : 'none of them';
          result.notes.push(
            `${page.locator} is judged the same as ${listed(plan.entityIds)}, so it joins ${joins}`,
          );
          continue;
        }
        if (plan.kind === 'wait' || plan.kind === 'ask') {
          result.waiting += 1;
          if (plan.kind === 'ask') {
            for (const candidate of plan.entityIds) {
              const question = { itemId: page.id, entityId: candidate };
              (askedAgain.has(pairOf(page.id, candidate)) ? again : fresh).push(question);
              const lineup =
                named === null
                  ? []
                  : lineupOf({
                      name: named.name,
                      sameScope: sameScope.filter(({ id }) => !refusingEntities.has(id)),
                      entityId: candidate,
                      apart: apartByPerson.get(candidate) ?? new Set<string>(),
                    });
              if (lineup.length > 0) lineups.set(pairOf(page.id, candidate), lineup);
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
        noteConsent(entityId, page.id);
        keepApart(entityId, page.id, pageVerdicts);
      }

      for (const claim of identityClaims(recordType, values)) {
        const owner = owners.get(claim.value);
        if (owner === undefined) {
          owners.set(claim.value, entityId);
          await tx.insert(entityKeys).values({ datasetId, value: claim.value, entityId });
        } else if (
          owner !== entityId &&
          // A name is no conflict between entities kept apart. An identifier always is.
          !(
            claim.rank >= recordType.identity.identifiers.length &&
            keptApart.get(entityId)?.has(owner) === true
          )
        ) {
          result.conflicts += 1;
          result.notes.push(
            `${page.locator} claims ${claim.value}, which belongs to ${owner}, while the page belongs to ${entityId}`,
          );
        }
      }
    }
    // One note for each name, so that a held page doesn't show only in a count. It doesn't say why
    // the name is contested: pages that give identifiers may disagree, or a person may have a
    // question to answer about a page of that name.
    for (const { label, pages: count } of held.values()) {
      const who = count === 1 ? 'page that gives only the name' : 'pages that give only the name';
      result.notes.push(
        `${count} ${who} "${cut(label)}" ${count === 1 ? 'waits' : 'wait'} until it’s settled which entities carry the name`,
      );
    }
    // Questions nobody has asked yet come first, so asking again can't crowd them out of the cap.
    result.questions = [...fresh, ...again].slice(0, maxQuestions);
    result.lineups = Object.fromEntries(
      result.questions.flatMap(({ itemId, entityId }) => {
        const lineup = lineups.get(pairOf(itemId, entityId));
        return lineup === undefined ? [] : [[pairOf(itemId, entityId), lineup] as const];
      }),
    );
    return result;
  });
}

/** "a and b", or "a, b and c". */
const listed = (ids: readonly string[]) =>
  ids.length < 3 ? ids.join(' and ') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;

/** At most this many characters of a name go into a note, so that the rest of it survives. */
const NOTE_NAME_MAX = 80;

/** A name for a note, cut at a whole character with an ellipsis where it is long. */
function cut(name: string): string {
  const characters = [...name];
  return characters.length > NOTE_NAME_MAX
    ? `${characters.slice(0, NOTE_NAME_MAX).join('')}…`
    : name;
}

export interface MatchSides {
  /** The page's record type, whose pack says what each relationship means. */
  recordType: string;
  page: { url: string; values: Record<string, FieldValue[]> };
  /**
   * The record, by its base page and the pages written as it (`basePages`): the first one's
   * address, by address, and their values merged.
   */
  entity: { url: string; values: Record<string, FieldValue[]> };
  /**
   * The names of the record's editions (`editionsOf`): its pages whose names differ from the
   * record's, each once, in order of text, at most 10.
   */
  editions: string[];
  /**
   * The names of every live page of the record, editions included, each once, by address: every
   * name the record carries. Not cut, since the model-number rule answers only when each one differs
   * from the page's by model marks alone.
   */
  entityNames: string[];
  /** The entity's live pages, whose sites' consent the question needs too. */
  entityItemIds: string[];
}

/** At most this many values of each field go into a question's state. */
const SIDE_VALUES_MAX = 20;

/** At most this many edition names go into a question's state, as many as its lineup shows. */
const SIDE_EDITIONS_MAX = MAX_LINEUP;

/**
 * A match question's two sides: the page's surviving values, and the record's, merged from its base
 * page and the pages written as it, with its editions' names apart (ADR 0003). Null when the page
 * isn't live or the entity has no live page.
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
    .select({ id: items.id, locator: items.locator, createdAt: items.createdAt })
    .from(items)
    .where(and(eq(items.entityId, input.entityId), eq(items.status, 'live')))
    .orderBy(asc(items.locator));
  const recordType = page === undefined ? undefined : input.definition.recordTypes[page.recordType];
  if (page === undefined || recordType === undefined || members.length === 0) return null;
  const said = await statementsOf(db, [page.id, ...members.map((member) => member.id)]);
  const editionIds = new Set(
    (
      await db
        .select({ itemId: judgements.itemId })
        .from(judgements)
        .where(and(eq(judgements.entityId, input.entityId), eq(judgements.verdict, 'edition')))
    ).map((row) => row.itemId),
  );
  const capped = (values: Record<string, FieldValue[]>) =>
    Object.fromEntries(
      Object.entries(values).map(([name, list]) => [name, list.slice(0, SIDE_VALUES_MAX)]),
    );
  const valuesOf = (itemId: string) => survivingValues(recordType, said.get(itemId) ?? []);
  // The record's pages as a snapshot sees them, by address, each with its own statements.
  const pages: EntityMember[] = members.map((member) => ({
    url: member.locator,
    firstSeen: member.createdAt.toISOString(),
    edition: editionIds.has(member.id),
    statements: said.get(member.id) ?? [],
  }));
  // Never null: the record has a live page.
  const base = basePages(recordType, pages)!;
  const theirs: Record<string, FieldValue[]> = {};
  for (const member of base) mergeValues(theirs, survivingValues(recordType, member.statements));
  const field = nameField(recordType);
  const [recordName] = field === null ? [] : (theirs[field] ?? []);
  const editions = [
    ...new Set(
      editionsOf(recordType, pages, typeof recordName === 'string' ? recordName : null).map(
        (edition) => edition.name,
      ),
    ),
  ].slice(0, SIDE_EDITIONS_MAX);
  const entityNames =
    field === null
      ? []
      : [
          ...new Set(
            members
              .flatMap((member) => valuesOf(member.id)[field] ?? [])
              .filter((name): name is string => typeof name === 'string'),
          ),
        ];
  return {
    recordType: page.recordType,
    page: { url: page.locator, values: capped(valuesOf(page.id)) },
    entity: { url: base[0]!.url, values: capped(theirs) },
    editions,
    entityNames,
    entityItemIds: members.map((member) => member.id),
  };
}

/** A page of a record, as publishing reads it. */
export interface EntityMemberRow {
  itemId: string;
  entityId: string;
  /** The page's address. */
  url: string;
  /** When Spatula first met the page. */
  firstSeen: Date;
  /** Whether the page joined its record as an edition. */
  edition: boolean;
}

/**
 * Each live page that belongs to a record, with when Spatula first met it and whether it joined
 * its record as an edition: what a record's base page and editions are worked out from (ADR 0003).
 * Earliest first, then by address.
 */
export async function entityMembers(db: Executor, datasetId: string): Promise<EntityMemberRow[]> {
  const rows = await db
    .select({
      itemId: items.id,
      entityId: items.entityId,
      url: items.locator,
      firstSeen: items.createdAt,
      verdict: judgements.verdict,
    })
    .from(items)
    .leftJoin(
      judgements,
      and(eq(judgements.itemId, items.id), eq(judgements.entityId, items.entityId)),
    )
    .where(and(eq(items.datasetId, datasetId), eq(items.status, 'live'), isNotNull(items.entityId)))
    .orderBy(asc(items.createdAt), asc(items.locator));
  return rows.map(({ verdict, entityId, ...row }) => ({
    ...row,
    entityId: entityId!,
    edition: verdict === 'edition',
  }));
}
