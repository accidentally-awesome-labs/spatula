import { describe, expect, it } from 'vitest';
import { stableStringify } from './ids';
import type { StatementView } from './survivorship';
import { countingIds, testTaxonomySeed } from './testing/taxonomy';
import { applyChanges, type TaxonomyChange } from './taxonomy-changes';
import { canonicalTaxonomy, placementIssues, placeRecord } from './taxonomy-records';
import {
  findItem,
  NONE_SHELF,
  seedTaxonomy,
  type Taxonomy,
  type TaxonomySubject,
} from './taxonomy';

const seeded = (): Taxonomy => {
  const result = seedTaxonomy(testTaxonomySeed(), countingIds());
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.taxonomy;
};
const T = seeded();
const id = (subject: TaxonomySubject, slug: string) => findItem(T, subject, slug)!.id;
/** The test taxonomy's next version, after these changes. None of them makes an ID. */
const changed = (...changes: TaxonomyChange[]): Taxonomy => {
  const result = applyChanges(T, changes, () => {
    throw new Error('No change here makes an ID.');
  });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.taxonomy;
};

const PAGE = 'https://maker.example/products/amp';
const SEEN = '2026-10-19T00:00:00.000Z';
/** A current statement about the record, from its page. */
const said = (
  property: string,
  value: string,
  method: StatementView['method'] = 'llm',
  confidence = 0.95,
): StatementView => ({
  property,
  value,
  valueKey: value,
  method,
  confidence,
  lastSeen: SEEN,
  sourceUrl: PAGE,
  position: null,
});
/** A field's provenance, from the record's page. */
const from = (method: StatementView['method'], confidence: number) => ({
  sourceUrl: PAGE,
  fetchedAt: SEEN,
  method,
  confidence,
});

describe('placeRecord', () => {
  it('places a record on its best live shelf, with what the shelf implies and the features on it', () => {
    const placed = placeRecord(T, [
      said('shelf', id('shelf', 'headphone-amps'), 'llm', 0.97),
      said('shelf', id('shelf', 'power-amps'), 'human', 1),
      said('functions', id('function', 'dac'), 'llm', 0.95),
      // Power amps imply amplifier, so the decider's statement of it adds nothing.
      said('functions', id('function', 'amplifier'), 'llm', 0.99),
      said('features', id('value', 'speakers'), 'llm', 0.95),
      said('features', id('value', 'headphones'), 'llm', 0.92),
      // Back isn't a feature of amplifiers, whoever says it.
      said('features', id('value', 'open'), 'human', 1),
      said('brand', 'Maker', 'rule', 1),
    ]);
    expect(placed).toEqual({
      fields: {
        shelf: id('shelf', 'power-amps'),
        functions: [id('function', 'dac'), id('function', 'amplifier')],
        features: {
          [id('feature', 'drives')]: [id('value', 'headphones'), id('value', 'speakers')],
        },
        category: 'Amplifiers',
      },
      provenance: {
        shelf: from('human', 1),
        functions: from('llm', 0.95),
        features: from('llm', 0.92),
        category: from('human', 1),
      },
    });
  });

  it('follows a merge, drops what’s retired, and gives a feature that takes one value its best statement’s', () => {
    const t = changed(
      { kind: 'merge', subject: 'shelf', from: 'preamps', into: 'power-amps' },
      { kind: 'retire', subject: 'value', item: 'iems' },
    );
    // The decider put it on preamps before the merge: it's on power amps now, still the decider's.
    const merged = placeRecord(t, [
      said('shelf', id('shelf', 'preamps')),
      said('features', id('value', 'iems')),
      said('features', id('value', 'speakers'), 'llm', 0.9),
    ]);
    expect(merged).toEqual({
      fields: {
        shelf: id('shelf', 'power-amps'),
        functions: [id('function', 'amplifier')],
        features: { [id('feature', 'drives')]: [id('value', 'speakers')] },
        category: 'Amplifiers',
      },
      provenance: {
        shelf: from('llm', 0.95),
        functions: from('llm', 0.95),
        features: from('llm', 0.9),
        category: from('llm', 0.95),
      },
    });
    const back = placeRecord(T, [
      said('shelf', id('shelf', 'over-ear')),
      said('features', id('value', 'open'), 'llm', 0.95),
      said('features', id('value', 'closed'), 'human', 1),
    ]);
    expect(back?.fields.features).toEqual({ [id('feature', 'back')]: [id('value', 'closed')] });
    expect(back?.provenance.features).toEqual(from('human', 1));
  });

  it('leaves a record out when no statement names a live shelf', () => {
    const t = changed({ kind: 'retire', subject: 'shelf', item: 'on-ear' });
    expect(placeRecord(T, [])).toBeNull();
    expect(placeRecord(T, [said('functions', id('function', 'dac'))])).toBeNull();
    expect(placeRecord(t, [said('shelf', id('shelf', 'on-ear'), 'human', 1)])).toBeNull();
    expect(placeRecord(T, [said('shelf', NONE_SHELF, 'human', 1)])).toBeNull();
    // A person's shelf that was retired gives way to the decider's live one.
    const placed = placeRecord(t, [
      said('shelf', id('shelf', 'on-ear'), 'human', 1),
      said('shelf', id('shelf', 'over-ear'), 'llm', 0.96),
    ]);
    expect(placed?.fields.shelf).toBe(id('shelf', 'over-ear'));
  });

  it('gives functions the shelf’s provenance when the shelf implies them all, and an empty list none', () => {
    expect(placeRecord(T, [said('shelf', id('shelf', 'dacs'), 'rule', 1)])).toEqual({
      fields: {
        shelf: id('shelf', 'dacs'),
        functions: [id('function', 'dac')],
        features: {},
        category: 'DACs',
      },
      provenance: { shelf: from('rule', 1), functions: from('rule', 1), category: from('rule', 1) },
    });
    // A page that fell back to Amplifiers, which implies nothing, with no function stated.
    const amps = placeRecord(T, [said('shelf', id('shelf', 'amplifiers'))]);
    expect(amps?.fields.functions).toEqual([]);
    expect(amps?.provenance).not.toHaveProperty('functions');
  });
});

describe('placementIssues', () => {
  it('finds nothing wrong with a place placeRecord made', () => {
    const places = [
      [
        said('shelf', id('shelf', 'headphone-amps')),
        said('functions', id('function', 'dac')),
        said('features', id('value', 'iems')),
      ],
      [said('shelf', id('shelf', 'over-ear')), said('features', id('value', 'closed'))],
      [said('shelf', id('shelf', 'amplifiers')), said('features', id('value', 'speakers'))],
      [said('shelf', id('shelf', 'dacs'), 'rule', 1)],
    ];
    for (const statements of places) {
      const placed = placeRecord(T, statements);
      expect(placed).not.toBeNull();
      expect(placementIssues(T, placed!.fields)).toEqual([]);
    }
  });

  it('says what keeps fields from being a place in the taxonomy', () => {
    const t = changed({ kind: 'retire', subject: 'value', item: 'iems' });
    const drives = id('feature', 'drives');
    const back = id('feature', 'back');
    expect(
      placementIssues(t, {
        shelf: id('shelf', 'power-amps'),
        functions: [id('function', 'dac'), id('function', 'dac')],
        features: {
          [drives]: [id('value', 'iems')],
          [back]: [id('value', 'open'), id('value', 'closed')],
        },
        category: 'Power amps',
      }),
    ).toEqual([
      { path: ['functions', 1], message: 'DAC is listed twice.' },
      { path: ['functions'], message: 'functions leaves out Amplifier, which Power amps implies.' },
      { path: ['features', drives, 0], message: 'It isn’t a live value of Drives.' },
      { path: ['features', back], message: 'Back isn’t a feature of Power amps.' },
      { path: ['features', back], message: 'Back takes exactly one value.' },
      {
        path: ['category'],
        message: 'category is the name of the shelf’s category: Amplifiers.',
      },
    ]);
    expect(placementIssues(T, { functions: 'dac', features: [] })).toEqual([
      {
        path: ['shelf'],
        message: 'A record’s shelf is a live shelf of the snapshot’s taxonomy.',
      },
      { path: ['functions'], message: 'functions lists function IDs.' },
      { path: ['features'], message: 'features lists value IDs by feature ID.' },
    ]);
  });
});

describe('canonicalTaxonomy', () => {
  it('writes the contract’s key order, whatever order the taxonomy was read in', () => {
    const t = changed({ kind: 'merge', subject: 'shelf', from: 'preamps', into: 'power-amps' });
    // jsonb gives an object's keys back in an order of its own; sorted keys stand in for it here.
    const read = JSON.parse(stableStringify(t)) as Taxonomy;
    const written = canonicalTaxonomy(read);
    expect(JSON.stringify(written)).toBe(JSON.stringify(canonicalTaxonomy(t)));
    expect(written).toEqual(t);
    expect(Object.keys(written)).toEqual([
      'version',
      'scope',
      'shelves',
      'functions',
      'features',
      'migrations',
    ]);
    expect(Object.keys(written.shelves[0]!)).toEqual([
      'id',
      'slug',
      'name',
      'description',
      'parentId',
      'implies',
      'sortOrder',
      'retiredIn',
    ]);
    expect(Object.keys(written.functions[0]!)).toEqual([
      'id',
      'slug',
      'name',
      'description',
      'sortOrder',
      'retiredIn',
    ]);
    expect(Object.keys(written.features[0]!)).toEqual([
      'id',
      'slug',
      'name',
      'description',
      'cardinality',
      'shelves',
      'sortOrder',
      'retiredIn',
      'values',
    ]);
    expect(Object.keys(written.features[0]!.values[0]!)).toEqual([
      'id',
      'slug',
      'name',
      'description',
      'sortOrder',
      'retiredIn',
    ]);
    expect(Object.keys(written.migrations[0]!)).toEqual([
      'version',
      'kind',
      'subject',
      'from',
      'to',
    ]);
    // It copies: changing what it wrote changes nothing it read.
    written.shelves[0]!.implies.push('tx_00000000000000000098');
    expect(read.shelves[0]!.implies).toEqual(t.shelves[0]!.implies);
  });
});
