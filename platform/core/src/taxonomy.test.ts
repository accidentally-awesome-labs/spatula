import { describe, expect, it } from 'vitest';
import {
  categoryOf,
  exportTaxonomy,
  featuresFor,
  findItem,
  impliedFunctions,
  resolveId,
  seedTaxonomy,
  shelfPath,
  subcategoriesOf,
  taxonomyIssues,
  taxonomySchema,
  taxonomySeedSchema,
  TX_ID,
  type Taxonomy,
} from './taxonomy';

/** IDs in order, each valid: tx_ and 20 digits. */
const counting = () => {
  let n = 0;
  return () => `tx_${String((n += 1)).padStart(20, '0')}`;
};

const SEED = taxonomySeedSchema.parse({
  scope:
    'Hi-fi made for audio: headphones, DACs, and amplifiers. Out of scope: accessories (cables, stands).',
  functions: [
    { slug: 'dac', name: 'DAC', description: 'Converts digital audio to analog' },
    {
      slug: 'pre-amp',
      name: 'Pre-amp',
      description: 'Selects inputs and sets volume at line level',
    },
    { slug: 'amplifier', name: 'Amplifier', description: 'Drives headphones, IEMs, or speakers' },
    {
      slug: 'headphones',
      name: 'Headphones',
      description: 'Turns a signal into sound on the ears',
    },
  ],
  shelves: [
    {
      slug: 'headphones',
      name: 'Headphones',
      description: 'Worn over or on the ears with a headband',
      implies: ['headphones'],
      children: [
        {
          slug: 'over-ear',
          name: 'Over-ear',
          description: 'Cups around the ears',
          implies: ['headphones'],
        },
        {
          slug: 'on-ear',
          name: 'On-ear',
          description: 'Pads on the ears',
          implies: ['headphones'],
        },
      ],
    },
    {
      slug: 'dacs',
      name: 'DACs',
      description: 'Convert digital audio to analog',
      implies: ['dac'],
    },
    {
      slug: 'amplifiers',
      name: 'Amplifiers',
      description: 'Set a signal’s level or drive headphones or speakers',
      children: [
        {
          slug: 'headphone-amps',
          name: 'Headphone amps',
          description: 'Drive headphones',
          implies: ['amplifier'],
        },
        {
          slug: 'preamps',
          name: 'Preamps',
          description: 'Set volume at line level',
          implies: ['pre-amp'],
        },
        {
          slug: 'power-amps',
          name: 'Power amps',
          description: 'Drive speakers',
          implies: ['amplifier'],
        },
      ],
    },
  ],
  features: [
    {
      slug: 'back',
      name: 'Back',
      description: 'Whether the cups let sound through',
      cardinality: 'one',
      shelves: ['headphones'],
      values: [
        { slug: 'open', name: 'Open', description: 'Cups that let sound through' },
        { slug: 'closed', name: 'Closed', description: 'Sealed cups' },
      ],
    },
    {
      slug: 'drives',
      name: 'Drives',
      description: 'What its amplifier is built for',
      cardinality: 'many',
      shelves: ['amplifiers'],
      values: [
        { slug: 'iems', name: 'IEMs', description: 'In-ear monitors' },
        { slug: 'headphones', name: 'Headphones', description: 'Headphones' },
        { slug: 'speakers', name: 'Speakers', description: 'Loudspeakers' },
      ],
    },
  ],
});

const seeded = (): Taxonomy => {
  const result = seedTaxonomy(SEED, counting());
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.taxonomy;
};
const id = (t: Taxonomy, subject: 'shelf' | 'function' | 'feature' | 'value', slug: string) =>
  findItem(t, subject, slug)!.id;

describe('seedTaxonomy', () => {
  it('makes version 1, with IDs, places, and implied functions', () => {
    const t = seeded();
    expect(t.version).toBe(1);
    expect(t.migrations).toEqual([]);
    for (const shelf of t.shelves) expect(shelf.id).toMatch(TX_ID);
    const amps = findItem(t, 'shelf', 'amplifiers')!;
    expect(t.shelves.find((shelf) => shelf.slug === 'power-amps')).toMatchObject({
      parentId: amps.id,
      implies: [id(t, 'function', 'amplifier')],
      sortOrder: 3,
      retiredIn: null,
    });
    expect(amps).toMatchObject({ parentId: null, implies: [], sortOrder: 3 });
    expect(t.features[1]).toMatchObject({
      slug: 'drives',
      cardinality: 'many',
      shelves: [amps.id],
      sortOrder: 2,
    });
    expect(taxonomySchema.parse(t)).toEqual(t);
  });

  it('keeps an ID the file gives, so an export seeds the same taxonomy', () => {
    const t = seeded();
    const again = seedTaxonomy(exportTaxonomy(t), () => {
      throw new Error('no ID is new');
    });
    expect(again).toEqual({ ok: true, taxonomy: t });
  });

  it('says what’s wrong: an unknown function or shelf, a slug twice, a name twice among siblings', () => {
    const bad = taxonomySeedSchema.parse({
      ...SEED,
      shelves: [
        ...SEED.shelves,
        { slug: 'dacs', name: 'More DACs', description: 'Twice', implies: ['streamer'] },
        { slug: 'digital', name: 'DACs', description: 'A sibling with the same name' },
      ],
      features: [{ ...SEED.features[0]!, shelves: ['nowhere'] }],
    });
    const result = seedTaxonomy(bad, counting());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('There’s no function called streamer.'),
        expect.stringContaining('There’s no shelf called nowhere.'),
        expect.stringContaining('Another shelf is also called dacs.'),
        expect.stringContaining('Another live sibling is also named DACs.'),
      ]),
    );
  });
});

describe('taxonomyIssues', () => {
  it('keeps shelves to two levels, and live items to live parents and functions', () => {
    const t = seeded();
    const over = t.shelves.find((shelf) => shelf.slug === 'over-ear')!;
    const deep = {
      ...over,
      id: 'tx_00000000000000000099',
      slug: 'deep',
      name: 'Deep',
      parentId: over.id,
    };
    expect(taxonomyIssues({ ...t, shelves: [...t.shelves, deep] })).toContainEqual({
      path: ['shelves', t.shelves.length, 'parentId'],
      message: 'Shelves go two levels deep at most: a category and its subcategories.',
    });
    const retiredFn = t.functions.map((fn) => (fn.slug === 'dac' ? { ...fn, retiredIn: 1 } : fn));
    expect(taxonomyIssues({ ...t, functions: retiredFn })).toContainEqual(
      expect.objectContaining({ message: 'A live shelf implies only live functions.' }),
    );
    // "none" is the shelf part's answer for none of these, so no shelf takes it.
    const none = t.shelves.map((shelf) =>
      shelf.slug === 'dacs' ? { ...shelf, slug: 'none' } : shelf,
    );
    expect(taxonomyIssues({ ...t, shelves: none })).toContainEqual({
      path: ['shelves', 3, 'slug'],
      message: 'A shelf can’t be called none: that’s the answer for none of these.',
    });
  });

  it('checks each migration’s shape against its kind', () => {
    const t = seeded();
    const amps = id(t, 'shelf', 'amplifiers');
    const power = id(t, 'shelf', 'power-amps');
    const withMigrations = (migrations: Taxonomy['migrations']): Taxonomy => ({
      ...t,
      version: 2,
      migrations,
    });
    expect(
      taxonomyIssues(
        withMigrations([
          { version: 2, kind: 'rename', subject: 'shelf', from: power, to: power },
          { version: 2, kind: 'split', subject: 'shelf', from: amps, to: [power] },
        ]),
      ),
    ).toEqual([]);
    expect(
      taxonomyIssues(
        withMigrations([{ version: 2, kind: 'merge', subject: 'shelf', from: power, to: null }]),
      ),
    ).toContainEqual(
      expect.objectContaining({ message: 'A merge names the one item it merges into.' }),
    );
    expect(
      taxonomyIssues(
        withMigrations([{ version: 3, kind: 'retire', subject: 'shelf', from: power, to: null }]),
      ),
    ).toContainEqual(
      expect.objectContaining({ message: 'A migration can’t be newer than its taxonomy.' }),
    );
  });
});

describe('lookups', () => {
  it('find categories, subcategories, features, and implied functions', () => {
    const t = seeded();
    const power = id(t, 'shelf', 'power-amps');
    expect(categoryOf(t, power)?.slug).toBe('amplifiers');
    expect(subcategoriesOf(t, id(t, 'shelf', 'amplifiers')).map((shelf) => shelf.slug)).toEqual([
      'headphone-amps',
      'preamps',
      'power-amps',
    ]);
    // A subcategory carries its category's features.
    expect(featuresFor(t, power).map((feature) => feature.slug)).toEqual(['drives']);
    expect(featuresFor(t, id(t, 'shelf', 'dacs'))).toEqual([]);
    expect(impliedFunctions(t, power)).toEqual([id(t, 'function', 'amplifier')]);
    expect(shelfPath(t, power)).toBe('Amplifiers › Power amps');
    expect(findItem(t, 'value', 'speakers')?.name).toBe('Speakers');
    expect(findItem(t, 'shelf', id(t, 'shelf', 'dacs'))?.slug).toBe('dacs');
  });

  it('resolve a merged item to the one it was merged into, and a retired one to nothing', () => {
    const t = seeded();
    const preamps = id(t, 'shelf', 'preamps');
    const power = id(t, 'shelf', 'power-amps');
    const merged: Taxonomy = {
      ...t,
      version: 2,
      shelves: t.shelves.map((shelf) =>
        shelf.id === preamps ? { ...shelf, retiredIn: 2 } : shelf,
      ),
      migrations: [{ version: 2, kind: 'merge', subject: 'shelf', from: preamps, to: power }],
    };
    expect(resolveId(merged, 'shelf', preamps)).toBe(power);
    expect(resolveId(merged, 'shelf', power)).toBe(power);
    const retired: Taxonomy = {
      ...merged,
      version: 3,
      shelves: merged.shelves.map((shelf) =>
        shelf.id === power ? { ...shelf, retiredIn: 3 } : shelf,
      ),
      migrations: [
        ...merged.migrations,
        { version: 3, kind: 'retire', subject: 'shelf', from: power, to: null },
      ],
    };
    expect(resolveId(retired, 'shelf', preamps)).toBeNull();
    expect(resolveId(t, 'shelf', 'tx_00000000000000000999')).toBeNull();
  });
});

describe('exportTaxonomy', () => {
  it('writes the seed file’s shape with IDs, leaving retired items out', () => {
    const t = seeded();
    const open = id(t, 'value', 'open');
    const exported = exportTaxonomy({
      ...t,
      version: 2,
      features: t.features.map((feature) => ({
        ...feature,
        values: feature.values.map((value) =>
          value.id === open ? { ...value, retiredIn: 2 } : value,
        ),
      })),
    });
    expect(exported.shelves[0]).toEqual({
      id: id(t, 'shelf', 'headphones'),
      slug: 'headphones',
      name: 'Headphones',
      description: 'Worn over or on the ears with a headband',
      implies: ['headphones'],
      children: [
        expect.objectContaining({ slug: 'over-ear', implies: ['headphones'] }),
        expect.objectContaining({ slug: 'on-ear' }),
      ],
    });
    expect(exported.features[0]!.values.map((value) => value.slug)).toEqual(['closed']);
    expect(taxonomySeedSchema.parse(exported)).toEqual(exported);
  });
});
