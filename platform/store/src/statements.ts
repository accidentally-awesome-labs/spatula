import { newId, type Method, type StatementInput, type StatementView } from '@spatula/core';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
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
 * what the LLM said, and the other way round.
 */
export async function writeStatements(
  db: Executor,
  write: {
    datasetId: string;
    itemId: string;
    fetchId: string;
    seenAt: Date;
    methods: readonly Method[];
    statements: StatementInput[];
  },
): Promise<StatementCounts> {
  const outside = write.statements.find((statement) => !write.methods.includes(statement.method));
  if (outside !== undefined) {
    throw new Error(
      `A ${outside.method} statement can’t be written for ${write.methods.join(', ')}`,
    );
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
        .set({ lastSeen: write.seenAt, lastFetchId: write.fetchId })
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
          firstSeen: write.seenAt,
          lastSeen: write.seenAt,
        })),
      );
    }
    return { added: added.length, reseen: reseen.length, withdrawn: withdrawn.length };
  });
}

/** An unchanged page says what it said before: its current statements are re-seen. */
export async function reseeStatements(
  db: Executor,
  input: { itemId: string; fetchId: string; seenAt: Date; methods?: readonly Method[] },
): Promise<number> {
  const rows = await db
    .update(statements)
    .set({ lastSeen: input.seenAt, lastFetchId: input.fetchId })
    .where(
      and(
        eq(statements.itemId, input.itemId),
        isNull(statements.withdrawnAt),
        input.methods === undefined ? undefined : inArray(statements.method, [...input.methods]),
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
