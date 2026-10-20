import { newId, type Method, type StatementInput, type StatementView } from '@spatula/core';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { items, statements } from './schema';

export interface StatementCounts {
  added: number;
  reseen: number;
  withdrawn: number;
}

/** A current statement of a live item, with the item and the entity it belongs to. */
export interface CurrentStatement extends StatementView {
  itemId: string;
  entityId: string | null;
  recordType: string;
}

const keyOf = (statement: { property: string; method: string; valueKey: string }) =>
  `${statement.property}\u0000${statement.method}\u0000${statement.valueKey}`;

/**
 * Writes what an extraction found, for the methods it speaks for. A value already current is
 * re-seen; a new value is a new statement; a current value the extraction no longer finds is
 * withdrawn. Statements of other methods are left alone, so a page extraction never withdraws
 * what the LLM said, and the other way round. Naming `properties` narrows the write the same way:
 * it adds, re-sees, and withdraws only those properties' statements, and rejects any other.
 */
export async function writeStatements(
  db: Executor,
  write: {
    datasetId: string;
    itemId: string;
    fetchId: string;
    seenAt: Date;
    methods: readonly Method[];
    /**
     * The properties the write speaks for. Others' statements are left alone, so a page's
     * extraction never withdraws a decided category, and the LLM's specs step never withdraws the
     * LLM's classification. Absent means every property.
     */
    properties?: readonly string[];
    statements: StatementInput[];
    /**
     * The capture the values were read from (ADR 0008). A new value cites it; a value seen again
     * keeps the capture it cites, or takes this one if it has none, as a value from before the
     * archive does. Absent or null cites nothing.
     */
    captureId?: string | null;
  },
): Promise<StatementCounts> {
  const outside = write.statements.find((statement) => !write.methods.includes(statement.method));
  if (outside !== undefined) {
    throw new Error(
      `A ${outside.method} statement can’t be written for ${write.methods.join(', ')}`,
    );
  }
  const strayProperty =
    write.properties === undefined
      ? undefined
      : write.statements.find((statement) => !write.properties!.includes(statement.property));
  if (strayProperty !== undefined) {
    throw new Error(
      `A ${strayProperty.property} statement can’t be written for ${write.properties!.join(', ')}`,
    );
  }
  // A write that speaks for no property has nothing to add, re-see, or withdraw.
  if (write.properties !== undefined && write.properties.length === 0) {
    return { added: 0, reseen: 0, withdrawn: 0 };
  }
  return db.transaction(async (tx) => {
    const current = await tx
      .select({
        id: statements.id,
        property: statements.property,
        method: statements.method,
        valueKey: statements.valueKey,
      })
      .from(statements)
      .where(
        and(
          eq(statements.itemId, write.itemId),
          inArray(statements.method, [...write.methods]),
          write.properties === undefined
            ? undefined
            : inArray(statements.property, [...write.properties]),
          isNull(statements.withdrawnAt),
        ),
      );
    const existing = new Map(current.map((row) => [keyOf(row), row.id]));
    const wanted = new Map<string, StatementInput>();
    for (const statement of write.statements) {
      if (!wanted.has(keyOf(statement))) wanted.set(keyOf(statement), statement);
    }
    const reseen = [...wanted.keys()].flatMap((key) => existing.get(key) ?? []);
    const added = [...wanted]
      .filter(([key]) => !existing.has(key))
      .map(([, statement]) => statement);
    const withdrawn = [...existing].filter(([key]) => !wanted.has(key)).map(([, id]) => id);

    if (reseen.length > 0) {
      await tx
        .update(statements)
        .set({ lastSeen: write.seenAt, lastFetchId: write.fetchId, ...citing(write.captureId) })
        .where(inArray(statements.id, reseen));
    }
    if (withdrawn.length > 0) {
      await tx
        .update(statements)
        .set({ withdrawnAt: write.seenAt })
        .where(inArray(statements.id, withdrawn));
    }
    if (added.length > 0) {
      await tx.insert(statements).values(
        added.map((statement) => ({
          id: newId('st'),
          datasetId: write.datasetId,
          itemId: write.itemId,
          ...statement,
          fetchId: write.fetchId,
          lastFetchId: write.fetchId,
          captureId: write.captureId ?? null,
          firstSeen: write.seenAt,
          lastSeen: write.seenAt,
        })),
      );
    }
    return { added: added.length, reseen: reseen.length, withdrawn: withdrawn.length };
  });
}

/**
 * An unchanged page says what it said before: its current statements are re-seen. Naming
 * `methods` or `properties` re-sees only those, so a step that confirmed some of a page's
 * statements doesn't re-see what another step decided. Absent means all, and an empty list
 * re-sees nothing.
 */
export async function reseeStatements(
  db: Executor,
  input: {
    itemId: string;
    fetchId: string;
    seenAt: Date;
    methods?: readonly Method[];
    properties?: readonly string[];
    /** The capture that saw them again: a value that cites none takes it (ADR 0008). */
    captureId?: string | null;
  },
): Promise<number> {
  if (input.properties !== undefined && input.properties.length === 0) return 0;
  const rows = await db
    .update(statements)
    .set({ lastSeen: input.seenAt, lastFetchId: input.fetchId, ...citing(input.captureId) })
    .where(
      and(
        eq(statements.itemId, input.itemId),
        isNull(statements.withdrawnAt),
        input.methods === undefined ? undefined : inArray(statements.method, [...input.methods]),
        input.properties === undefined
          ? undefined
          : inArray(statements.property, [...input.properties]),
      ),
    )
    .returning({ id: statements.id });
  return rows.length;
}

/** The current statements of the dataset's live items, by item, property, and ID. */
export async function currentStatements(
  db: Executor,
  datasetId: string,
): Promise<CurrentStatement[]> {
  const rows = await db
    .select({
      itemId: statements.itemId,
      entityId: items.entityId,
      recordType: items.recordType,
      sourceUrl: items.locator,
      property: statements.property,
      value: statements.value,
      valueKey: statements.valueKey,
      method: statements.method,
      confidence: statements.confidence,
      lastSeen: statements.lastSeen,
      position: statements.position,
    })
    .from(statements)
    .innerJoin(items, eq(items.id, statements.itemId))
    .where(
      and(
        eq(statements.datasetId, datasetId),
        eq(items.status, 'live'),
        isNull(statements.withdrawnAt),
      ),
    )
    .orderBy(asc(statements.itemId), asc(statements.property), asc(statements.id));
  return rows.map((row) => ({ ...row, lastSeen: row.lastSeen.toISOString() }));
}

/** The current statements of these items, by item, as survivorship reads them. */
export async function statementsOf(
  db: Executor,
  itemIds: readonly string[],
): Promise<Map<string, StatementView[]>> {
  const said = new Map<string, StatementView[]>();
  if (itemIds.length === 0) return said;
  const rows = await db
    .select({
      itemId: statements.itemId,
      sourceUrl: items.locator,
      property: statements.property,
      value: statements.value,
      valueKey: statements.valueKey,
      method: statements.method,
      confidence: statements.confidence,
      lastSeen: statements.lastSeen,
      position: statements.position,
    })
    .from(statements)
    .innerJoin(items, eq(items.id, statements.itemId))
    .where(and(inArray(statements.itemId, [...itemIds]), isNull(statements.withdrawnAt)))
    .orderBy(asc(statements.itemId), asc(statements.property), asc(statements.id));
  for (const { itemId, ...row } of rows) {
    const view = { ...row, lastSeen: row.lastSeen.toISOString() };
    const list = said.get(itemId);
    if (list === undefined) said.set(itemId, [view]);
    else list.push(view);
  }
  return said;
}

/**
 * What a write that re-sees values sets of their citation: a value that cites a capture keeps it,
 * and one that cites none, as a value from before the archive does, takes this one (ADR 0008).
 */
function citing(captureId: string | null | undefined) {
  return captureId === undefined || captureId === null
    ? {}
    : { captureId: sql`coalesce(${statements.captureId}, ${captureId})` };
}
