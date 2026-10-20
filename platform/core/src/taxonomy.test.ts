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
  type Feature,
  type FeatureValue,
  type Taxonomy,
  type TaxonomyFunction,
  type TaxonomyMigration,
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

// The edits below change one thing in the seeded taxonomy and read the issues that follow.
const editFunction = (t: Taxonomy, at: number, patch: Partial<TaxonomyFunction>): Taxonomy => ({
  ...t,
  functions: t.functions.map((fn, index) => (index === at ? { ...fn, ...patch } : fn)),
});
const editFeature = (t: Taxonomy, at: number, patch: Partial<Feature>): Taxonomy => ({
  ...t,
  features: t.features.map((feature, index) => (index === at ? { ...feature, ...patch } : feature)),
});
const editValue = (
  t: Taxonomy,
  featureAt: number,
  valueAt: number,
  patch: Partial<FeatureValue>,
): Taxonomy => ({
  ...t,
  features: t.features.map((feature, index) =>
    index === featureAt
      ? {
          ...feature,
          values: feature.values.map((value, at) =>
            at === valueAt ? { ...value, ...patch } : value,
          ),
        }
      : feature,
  ),
});
const retireShelves = (t: Taxonomy, ids: string[], version: number): Taxonomy => ({
  ...t,
  shelves: t.shelves.map((shelf) =>
    ids.includes(shelf.id) ? { ...shelf, retiredIn: version } : shelf,
  ),
});
const shelfIndex = (t: Taxonomy, slug: string) =>
  t.shelves.findIndex((shelf) => shelf.slug === slug);

describe('taxonomyIssues: IDs, slugs, and names', () => {
  it('finds an ID used twice, within a kind or across kinds', () => {
    const t = seeded();
    const open = t.features[0]!.values[0]!;
    expect(taxonomyIssues(editValue(t, 0, 1, { id: open.id }))).toEqual([
      { path: ['features', 0, 'values', 1, 'id'], message: `The ID ${open.id} is used twice.` },
    ]);
    const shelfId = t.shelves[0]!.id;
    expect(taxonomyIssues(editFunction(t, 3, { id: shelfId }))).toContainEqual({
      path: ['functions', 3, 'id'],
      message: `The ID ${shelfId} is used twice.`,
    });
  });

  it('keeps slugs unique within a kind, retired items included', () => {
    const t = seeded();
    expect(taxonomyIssues(editFunction(t, 1, { slug: 'dac' }))).toEqual([
      { path: ['functions', 1, 'slug'], message: 'Another function is also called dac.' },
    ]);
    expect(taxonomyIssues(editFeature(t, 1, { slug: 'back' }))).toEqual([
      { path: ['features', 1, 'slug'], message: 'Another feature is also called back.' },
    ]);
    // Within a feature, and across features: value slugs are unique in the whole taxonomy.
    expect(taxonomyIssues(editValue(t, 0, 1, { slug: 'open' }))).toEqual([
      { path: ['features', 0, 'values', 1, 'slug'], message: 'Another value is also called open.' },
    ]);
    expect(taxonomyIssues(editValue(t, 0, 0, { slug: 'iems' }))).toEqual([
      { path: ['features', 1, 'values', 0, 'slug'], message: 'Another value is also called iems.' },
    ]);
    // A retired item keeps its slug.
    expect(
      taxonomyIssues(editValue(editValue(t, 0, 1, { retiredIn: 1 }), 0, 1, { slug: 'open' })),
    ).toEqual([
      { path: ['features', 0, 'values', 1, 'slug'], message: 'Another value is also called open.' },
    ]);
  });

  it('keeps names unique among live siblings, whatever their case', () => {
    const t = seeded();
    expect(taxonomyIssues(editFunction(t, 1, { name: 'dac' }))).toEqual([
      { path: ['functions', 1, 'name'], message: 'Another live sibling is also named dac.' },
    ]);
    expect(taxonomyIssues(editFeature(t, 1, { name: 'BACK' }))).toEqual([
      { path: ['features', 1, 'name'], message: 'Another live sibling is also named BACK.' },
    ]);
    expect(taxonomyIssues(editValue(t, 0, 1, { name: 'OPEN' }))).toEqual([
      {
        path: ['features', 0, 'values', 1, 'name'],
        message: 'Another live sibling is also named OPEN.',
      },
    ]);
  });

  it('lets a retired item, or an item under another parent, share a name', () => {
    const t = seeded();
    // A retired value keeps the name a live one then takes.
    expect(taxonomyIssues(editValue(t, 0, 0, { name: 'Closed', retiredIn: 1 }))).toEqual([]);
    // Values are siblings within their feature only.
    expect(taxonomyIssues(editValue(t, 1, 0, { name: 'Open' }))).toEqual([]);
    // Shelves are siblings within their category: the top level, or one category's children.
    const overEar = shelfIndex(t, 'over-ear');
    expect(
      taxonomyIssues({
        ...t,
        shelves: t.shelves.map((shelf, index) =>
          index === overEar ? { ...shelf, name: 'DACs' } : shelf,
        ),
      }),
    ).toEqual([]);
  });
});

describe('taxonomyIssues: shelves, features, and what is live', () => {
  it('finds a reference to nothing', () => {
    const t = seeded();
    const nowhere = 'tx_00000000000000000999';
    const overEar = shelfIndex(t, 'over-ear');
    expect(
      taxonomyIssues({
        ...t,
        shelves: t.shelves.map((shelf, index) =>
          index === overEar ? { ...shelf, parentId: nowhere, implies: [nowhere] } : shelf,
        ),
      }),
    ).toEqual([
      { path: ['shelves', overEar, 'parentId'], message: `There’s no shelf ${nowhere}.` },
      { path: ['shelves', overEar, 'implies', 0], message: `There’s no function ${nowhere}.` },
    ]);
    expect(taxonomyIssues(editFeature(t, 0, { shelves: [nowhere] }))).toEqual([
      { path: ['features', 0, 'shelves', 0], message: `There’s no shelf ${nowhere}.` },
    ]);
  });

  it('keeps a live subcategory under a live category', () => {
    const t = seeded();
    const retired = retireShelves(t, [id(t, 'shelf', 'amplifiers')], 1);
    for (const slug of ['headphone-amps', 'preamps', 'power-amps']) {
      expect(taxonomyIssues(retired)).toContainEqual({
        path: ['shelves', shelfIndex(t, slug), 'parentId'],
        message: 'A live subcategory belongs to a live category.',
      });
    }
  });

  it('keeps a live feature to a live value, and the live shelves to between 1 and 254', () => {
    const t = seeded();
    const values = t.features[0]!.values;
    const noneLive = editFeature(t, 0, {
      values: values.map((value) => ({ ...value, retiredIn: 1 })),
    });
    expect(taxonomyIssues(noneLive)).toEqual([
      { path: ['features', 0, 'values'], message: 'A live feature keeps at least one live value.' },
    ]);
    // A retired feature may retire all its values.
    expect(taxonomyIssues(editFeature(noneLive, 0, { retiredIn: 1 }))).toEqual([]);
    const everyShelf = retireShelves(
      t,
      t.shelves.map((shelf) => shelf.id),
      1,
    );
    expect(taxonomyIssues(everyShelf)).toContainEqual({
      path: ['shelves'],
      message: 'Keep at least one live shelf.',
    });
    const crowd: Taxonomy = {
      ...t,
      features: [],
      shelves: Array.from({ length: 255 }, (_, index) => ({
        id: `tx_${String(index + 1000).padStart(20, '0')}`,
        slug: `shelf-${index}`,
        name: `Shelf ${index}`,
        description: 'One of many',
        parentId: null,
        implies: [],
        sortOrder: index + 1,
        retiredIn: null,
      })),
    };
    expect(taxonomyIssues(crowd)).toEqual([
      { path: ['shelves'], message: 'Keep at most 254 live shelves.' },
    ]);
  });

  it('refuses an item retired after its taxonomy’s version', () => {
    const t = seeded();
    const message = 'An item can’t be retired after its taxonomy’s version.';
    expect(taxonomyIssues(editValue(t, 0, 0, { retiredIn: 2 }))).toEqual([
      { path: ['features', 0, 'values', 0, 'retiredIn'], message },
    ]);
    expect(taxonomyIssues(editFunction(t, 0, { retiredIn: 2 }))).toContainEqual({
      path: ['functions', 0, 'retiredIn'],
      message,
    });
    expect(taxonomyIssues(retireShelves(t, [id(t, 'shelf', 'dacs')], 2))).toContainEqual({
      path: ['shelves', shelfIndex(t, 'dacs'), 'retiredIn'],
      message,
    });
    // At its own version, it's fine.
    expect(
      taxonomyIssues({ ...retireShelves(t, [id(t, 'shelf', 'dacs')], 2), version: 2 }),
    ).toEqual([]);
  });
});

describe('taxonomyIssues: migrations and the state they leave', () => {
  const setup = () => {
    const t = seeded();
    return {
      t,
      preamps: id(t, 'shelf', 'preamps'),
      power: id(t, 'shelf', 'power-amps'),
      headphoneAmps: id(t, 'shelf', 'headphone-amps'),
    };
  };
  const at = (
    t: Taxonomy,
    version: number,
    retiredIn: number | null,
    itemId: string,
    migrations: TaxonomyMigration[],
  ): Taxonomy => ({
    ...t,
    version,
    shelves: t.shelves.map((shelf) => (shelf.id === itemId ? { ...shelf, retiredIn } : shelf)),
    migrations,
  });
  const merge = (version: number, from: string, to: string): TaxonomyMigration => ({
    version,
    kind: 'merge',
    subject: 'shelf',
    from,
    to,
  });
  const restore = (version: number, from: string): TaxonomyMigration => ({
    version,
    kind: 'restore',
    subject: 'shelf',
    from,
    to: from,
  });

  it('finds an item left live after a merge, and one left retired after a restore', () => {
    const { t, preamps, power } = setup();
    expect(taxonomyIssues(at(t, 2, null, preamps, [merge(2, preamps, power)]))).toEqual([
      {
        path: ['migrations', 0],
        message: `${preamps} is live, and its last migration retires it.`,
      },
    ]);
    expect(
      taxonomyIssues(at(t, 3, 2, preamps, [merge(2, preamps, power), restore(3, preamps)])),
    ).toEqual([
      {
        path: ['migrations', 1],
        message: `${preamps} is retired, and its last migration restores it.`,
      },
    ]);
  });

  it('lets an item be merged, restored, and merged again, or retired after a restore', () => {
    const { t, preamps, power, headphoneAmps } = setup();
    const again = at(t, 4, 4, preamps, [
      merge(2, preamps, power),
      restore(3, preamps),
      merge(4, preamps, power),
    ]);
    expect(taxonomyIssues(again)).toEqual([]);
    expect(resolveId(again, 'shelf', preamps)).toBe(power);
    // The last merge says where it went.
    const elsewhere = at(t, 4, 4, preamps, [
      merge(2, preamps, power),
      restore(3, preamps),
      merge(4, preamps, headphoneAmps),
    ]);
    expect(taxonomyIssues(elsewhere)).toEqual([]);
    expect(resolveId(elsewhere, 'shelf', preamps)).toBe(headphoneAmps);
    const retired = at(t, 4, 4, preamps, [
      merge(2, preamps, power),
      restore(3, preamps),
      { version: 4, kind: 'retire', subject: 'shelf', from: preamps, to: null },
    ]);
    expect(taxonomyIssues(retired)).toEqual([]);
    expect(resolveId(retired, 'shelf', preamps)).toBeNull();
  });

  it('resolves a restored item to itself', () => {
    const { t, preamps, power } = setup();
    const restored = at(t, 3, null, preamps, [merge(2, preamps, power), restore(3, preamps)]);
    expect(taxonomyIssues(restored)).toEqual([]);
    expect(resolveId(restored, 'shelf', preamps)).toBe(preamps);
  });

  it('checks the rest of each kind’s shape, the subject, and the order', () => {
    const { t, preamps, power } = setup();
    const issuesOf = (migrations: TaxonomyMigration[]) =>
      taxonomyIssues({ ...t, version: 3, migrations });
    expect(
      issuesOf([{ version: 2, kind: 'retire', subject: 'shelf', from: power, to: power }]),
    ).toContainEqual({
      path: ['migrations', 0, 'to'],
      message: 'A retirement merges into nothing: its to is null.',
    });
    for (const kind of ['rename', 'move', 'restore'] as const) {
      expect(
        issuesOf([{ version: 2, kind, subject: 'shelf', from: power, to: preamps }]),
      ).toContainEqual({
        path: ['migrations', 0, 'to'],
        message: `A ${kind} keeps the item’s ID: its to is its from.`,
      });
    }
    const split = 'A split lists the subcategories its category gained.';
    expect(
      issuesOf([{ version: 2, kind: 'split', subject: 'shelf', from: power, to: power }]),
    ).toContainEqual({ path: ['migrations', 0, 'to'], message: split });
    expect(
      issuesOf([
        {
          version: 2,
          kind: 'split',
          subject: 'function',
          from: id(t, 'function', 'dac'),
          to: [power],
        },
      ]),
    ).toContainEqual({ path: ['migrations', 0, 'to'], message: split });
    expect(issuesOf([merge(2, power, power)])).toContainEqual({
      path: ['migrations', 0, 'to'],
      message: 'A merge names the one item it merges into.',
    });
    expect(
      issuesOf([{ version: 2, kind: 'rename', subject: 'function', from: power, to: power }]),
    ).toContainEqual({
      path: ['migrations', 0, 'from'],
      message: `${power} isn’t a listed function.`,
    });
    expect(
      issuesOf([
        { version: 3, kind: 'rename', subject: 'shelf', from: power, to: power },
        { version: 2, kind: 'rename', subject: 'shelf', from: power, to: power },
      ]),
    ).toContainEqual({
      path: ['migrations', 1, 'version'],
      message: 'Migrations are listed in version order.',
    });
  });
});

describe('taxonomySchema', () => {
  it('reports the issues taxonomyIssues finds, at their paths, and refuses a stray key', () => {
    const t = seeded();
    const dup = taxonomySchema.safeParse(editFunction(t, 1, { slug: 'dac' }));
    expect(dup.success).toBe(false);
    expect(dup.error?.issues).toEqual([
      expect.objectContaining({
        path: ['functions', 1, 'slug'],
        message: 'Another function is also called dac.',
      }),
    ]);
    expect(taxonomySchema.safeParse({ ...t, extra: true }).success).toBe(false);
    expect(taxonomySchema.safeParse(editFunction(t, 0, { id: 'tx_short' })).success).toBe(false);
  });
});

describe('exportTaxonomy: a feature’s shelves', () => {
  const noNewIds = () => {
    throw new Error('no ID is new');
  };

  it('exports a feature whose only shelf is retired with none, and the export seeds', () => {
    const t = seeded();
    const slugs = ['amplifiers', 'headphone-amps', 'preamps', 'power-amps'];
    const ids = slugs.map((slug) => id(t, 'shelf', slug));
    const retired: Taxonomy = {
      ...retireShelves(t, ids, 2),
      version: 2,
      migrations: ids.map(
        (from): TaxonomyMigration => ({
          version: 2,
          kind: 'retire',
          subject: 'shelf',
          from,
          to: null,
        }),
      ),
    };
    expect(taxonomyIssues(retired)).toEqual([]);
    const exported = exportTaxonomy(retired);
    expect(exported.shelves.map((shelf) => shelf.slug)).toEqual(['headphones', 'dacs']);
    expect(exported.features.map((feature) => [feature.slug, feature.shelves])).toEqual([
      ['back', ['headphones']],
      ['drives', []],
    ]);
    expect(taxonomySeedSchema.safeParse(exported).success).toBe(true);
    const again = seedTaxonomy(taxonomySeedSchema.parse(exported), noNewIds);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.taxonomy.features[1]!.shelves).toEqual([]);
  });

  it('exports a merged shelf as the shelf it was merged into, once', () => {
    const t = seeded();
    const over = id(t, 'shelf', 'over-ear');
    const on = id(t, 'shelf', 'on-ear');
    for (const shelves of [[over], [over, on], [on, over]]) {
      const merged: Taxonomy = {
        ...retireShelves(editFeature(t, 0, { shelves }), [over], 2),
        version: 2,
        migrations: [{ version: 2, kind: 'merge', subject: 'shelf', from: over, to: on }],
      };
      expect(taxonomyIssues(merged)).toEqual([]);
      const exported = exportTaxonomy(merged);
      expect(exported.features[0]!.shelves).toEqual(['on-ear']);
      const again = seedTaxonomy(taxonomySeedSchema.parse(exported), noNewIds);
      expect(again.ok && again.taxonomy.features[0]!.shelves).toEqual([on]);
    }
  });
});
