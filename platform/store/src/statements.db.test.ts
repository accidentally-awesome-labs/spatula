import { PAGE_METHODS, type PagesSource } from '@spatula/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { fetchOf, seedDataset, statementOf, T } from '../test/seed';
import { testDefinition } from './fixtures';
import { applyDefinition } from './datasets';
import { statements } from './schema';
import { currentStatements, reseeStatements, writeStatements } from './statements';

describe('writeStatements', () => {
  it('adds new values, re-sees old ones, and withdraws what the page stopped saying', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const first = await fetchOf(db, runId, a1!, T(0));
      const base = { datasetId: 'test-products', itemId: a1!.id, methods: PAGE_METHODS };
      expect(
        await writeStatements(db, {
          ...base,
          fetchId: first,
          seenAt: T(0),
          statements: [statementOf('name', 'A1'), statementOf('gtins', '00036000291452', 'jsonld')],
        }),
      ).toEqual({ added: 2, reseen: 0, withdrawn: 0 });

      const second = await fetchOf(db, runId, a1!, T(5));
      expect(
        await writeStatements(db, {
          ...base,
          fetchId: second,
          seenAt: T(5),
          statements: [
            statementOf('name', 'A1 Pro'),
            statementOf('gtins', '00036000291452', 'jsonld'),
          ],
        }),
      ).toEqual({ added: 1, reseen: 1, withdrawn: 1 });

      const current = await currentStatements(db, 'test-products');
      expect(
        current.map(({ property, value, lastSeen }) => ({ property, value, lastSeen })),
      ).toEqual([
        { property: 'gtins', value: '00036000291452', lastSeen: T(5).toISOString() },
        { property: 'name', value: 'A1 Pro', lastSeen: T(5).toISOString() },
      ]);
      // The old name is withdrawn, never rewritten: it still says what the page said then.
      const [old] = await db
        .select()
        .from(statements)
        .where(and(eq(statements.itemId, a1!.id), eq(statements.valueKey, 'A1')));
      expect(old).toMatchObject({
        value: 'A1',
        fetchId: first,
        lastFetchId: first,
        withdrawnAt: T(5),
      });
    }));

  it('speaks only for its own methods', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetchId = await fetchOf(db, runId, a1!, T(0));
      const base = { datasetId: 'test-products', itemId: a1!.id, fetchId, seenAt: T(0) };
      await writeStatements(db, {
        ...base,
        methods: PAGE_METHODS,
        statements: [statementOf('name', 'A1')],
      });
      await writeStatements(db, {
        ...base,
        methods: ['llm'],
        statements: [statementOf('specs', { label: 'Impedance', value: '300 Ω' }, 'llm')],
      });
      // A page that now says nothing withdraws the page's statements, not the LLM's.
      expect(await writeStatements(db, { ...base, methods: PAGE_METHODS, statements: [] })).toEqual(
        {
          added: 0,
          reseen: 0,
          withdrawn: 1,
        },
      );
      expect(
        (await currentStatements(db, 'test-products')).map((statement) => statement.property),
      ).toEqual(['specs']);
      await expect(
        writeStatements(db, { ...base, methods: ['llm'], statements: [statementOf('name', 'A1')] }),
      ).rejects.toThrow('rule');
    }));

  it('keeps one statement when the same value arrives twice', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetchId = await fetchOf(db, runId, a1!, T(0));
      const twice = [
        statementOf('gtins', '00036000291452', 'jsonld'),
        statementOf('gtins', '00036000291452', 'jsonld'),
      ];
      expect(
        await writeStatements(db, {
          datasetId: 'test-products',
          itemId: a1!.id,
          fetchId,
          seenAt: T(0),
          methods: PAGE_METHODS,
          statements: twice,
        }),
      ).toMatchObject({ added: 1 });
    }));

  it('reads back text made of digits as text', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const fetchId = await fetchOf(db, runId, a1!, T(0));
      await writeStatements(db, {
        datasetId: 'test-products',
        itemId: a1!.id,
        fetchId,
        seenAt: T(0),
        methods: PAGE_METHODS,
        statements: [statementOf('mpns', '508823', 'jsonld'), statementOf('name', 'true')],
      });
      // Drizzle parses json once. If postgres.js parsed it too, these would come back as a number
      // and a boolean.
      const current = await currentStatements(db, 'test-products');
      expect(current.map((statement) => statement.value)).toEqual(['508823', 'true']);
      expect(current.map((statement) => typeof statement.value)).toEqual(['string', 'string']);
    }));

  it('adds a value again once it has been withdrawn, and keeps the withdrawn row', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const base = { datasetId: 'test-products', itemId: a1!.id, methods: PAGE_METHODS };
      const first = await fetchOf(db, runId, a1!, T(0));
      await writeStatements(db, {
        ...base,
        fetchId: first,
        seenAt: T(0),
        statements: [statementOf('name', 'A1')],
      });
      const second = await fetchOf(db, runId, a1!, T(5));
      await writeStatements(db, {
        ...base,
        fetchId: second,
        seenAt: T(5),
        statements: [statementOf('name', 'A1 Pro')],
      });
      const third = await fetchOf(db, runId, a1!, T(10));
      expect(
        await writeStatements(db, {
          ...base,
          fetchId: third,
          seenAt: T(10),
          statements: [statementOf('name', 'A1')],
        }),
      ).toEqual({ added: 1, reseen: 0, withdrawn: 1 });

      // The first 'A1' stays withdrawn, as it was, and exactly one 'A1' is current.
      const rows = await db
        .select()
        .from(statements)
        .where(and(eq(statements.itemId, a1!.id), eq(statements.valueKey, 'A1')));
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.fetchId === first)).toMatchObject({
        lastSeen: T(0),
        withdrawnAt: T(5),
      });
      expect(rows.filter((row) => row.withdrawnAt === null)).toMatchObject([
        { fetchId: third, lastSeen: T(10) },
      ]);
      expect(
        (await currentStatements(db, 'test-products')).map((statement) => statement.value),
      ).toEqual(['A1']);
    }));
});

describe('reseeStatements', () => {
  it('re-sees an unchanged page’s statements, or only some methods’', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const first = await fetchOf(db, runId, a1!, T(0));
      const base = { datasetId: 'test-products', itemId: a1!.id, fetchId: first, seenAt: T(0) };
      await writeStatements(db, {
        ...base,
        methods: PAGE_METHODS,
        statements: [statementOf('name', 'A1')],
      });
      await writeStatements(db, {
        ...base,
        methods: ['llm'],
        statements: [statementOf('specs', { label: 'Impedance', value: '300 Ω' }, 'llm')],
      });

      const second = await fetchOf(db, runId, a1!, T(5));
      expect(
        await reseeStatements(db, {
          itemId: a1!.id,
          fetchId: second,
          seenAt: T(5),
          methods: ['llm'],
        }),
      ).toBe(1);
      const third = await fetchOf(db, runId, a1!, T(10));
      expect(await reseeStatements(db, { itemId: a1!.id, fetchId: third, seenAt: T(10) })).toBe(2);
      expect(
        (await currentStatements(db, 'test-products')).map(({ property, lastSeen }) => ({
          property,
          lastSeen,
        })),
      ).toEqual([
        { property: 'name', lastSeen: T(10).toISOString() },
        { property: 'specs', lastSeen: T(10).toISOString() },
      ]);
    }));

  it('leaves withdrawn statements alone when the page is re-seen', () =>
    withRollback(async (db) => {
      const {
        items: [a1],
        runId,
      } = await seedDataset(db);
      const base = { datasetId: 'test-products', itemId: a1!.id, methods: PAGE_METHODS };
      const first = await fetchOf(db, runId, a1!, T(0));
      await writeStatements(db, {
        ...base,
        fetchId: first,
        seenAt: T(0),
        statements: [statementOf('name', 'A1')],
      });
      const second = await fetchOf(db, runId, a1!, T(5));
      await writeStatements(db, {
        ...base,
        fetchId: second,
        seenAt: T(5),
        statements: [statementOf('name', 'A1 Pro')],
      });
      const [withdrawn] = await db
        .select()
        .from(statements)
        .where(and(eq(statements.itemId, a1!.id), eq(statements.valueKey, 'A1')));

      // Only 'A1 Pro' is current, so only it is re-seen. The withdrawn 'A1' keeps what it said.
      const third = await fetchOf(db, runId, a1!, T(10));
      expect(await reseeStatements(db, { itemId: a1!.id, fetchId: third, seenAt: T(10) })).toBe(1);
      const [after] = await db.select().from(statements).where(eq(statements.id, withdrawn!.id));
      expect(after).toMatchObject({ lastSeen: T(0), lastFetchId: first, withdrawnAt: T(5) });
    }));
});

describe('currentStatements', () => {
  it('shows live pages only, naming each page as the source', () =>
    withRollback(async (db) => {
      const {
        items: [a1, a2],
        runId,
      } = await seedDataset(db);
      for (const item of [a1!, a2!]) {
        const fetchId = await fetchOf(db, runId, item, T(0));
        await writeStatements(db, {
          datasetId: 'test-products',
          itemId: item.id,
          fetchId,
          seenAt: T(0),
          methods: PAGE_METHODS,
          statements: [statementOf('name', item.locator.endsWith('a1') ? 'A1' : 'A2')],
        });
      }
      const rows = await currentStatements(db, 'test-products');
      expect(
        rows.map(({ itemId, value, sourceUrl, entityId, recordType }) => ({
          itemId,
          value,
          sourceUrl,
          entityId,
          recordType,
        })),
      ).toEqual(
        [
          {
            itemId: a1!.id,
            value: 'A1',
            sourceUrl: a1!.locator,
            entityId: null,
            recordType: 'product',
          },
          {
            itemId: a2!.id,
            value: 'A2',
            sourceUrl: a2!.locator,
            entityId: null,
            recordType: 'product',
          },
        ].sort((a, b) => (a.itemId < b.itemId ? -1 : 1)),
      );

      // Dropping a2 from the definition takes its statements out of the current ones.
      const full = testDefinition();
      await applyDefinition(db, {
        ...full,
        sources: [{ ...(full.sources[0] as PagesSource), pages: [a1!.locator] }, full.sources[1]!],
      });
      expect(
        (await currentStatements(db, 'test-products')).map((statement) => statement.value),
      ).toEqual(['A1']);
    }));
});
