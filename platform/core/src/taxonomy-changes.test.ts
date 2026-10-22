import { describe, expect, it } from 'vitest';
import { newId } from './ids';
import { countingIds, testTaxonomySeed } from './testing/taxonomy';
import {
  applyChanges,
  autonomyKind,
  changeSchema,
  inScope,
  inverseChanges,
  type TaxonomyChange,
} from './taxonomy-changes';
import {
  exportTaxonomy,
  findItem,
  isLive,
  resolveId,
  seedTaxonomy,
  taxonomyIssues,
  type Taxonomy,
} from './taxonomy';

/** IDs that can't collide with the seeded taxonomy's. */
const ids = () => newId('tx');
const base = (): Taxonomy => {
  const seeded = seedTaxonomy(testTaxonomySeed(), countingIds());
  if (!seeded.ok) throw new Error(seeded.issues.join('\n'));
  return seeded.taxonomy;
};
const apply = (t: Taxonomy, ...changes: TaxonomyChange[]) => {
  const result = applyChanges(t, changes, ids);
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result;
};
/** What readers see of a taxonomy's items, without its version or migrations. */
const items = (t: Taxonomy) => ({
  scope: t.scope,
  shelves: t.shelves.filter(isLive).map(({ sortOrder: _, ...shelf }) => shelf),
  functions: t.functions.filter(isLive),
  features: t.features
    .filter(isLive)
    .map((feature) => ({ ...feature, values: feature.values.filter(isLive) })),
});

describe('applyChanges', () => {
  it('adds a subcategory under a category that has some, as the next version, with no migration', () => {
    const t = base();
    const { taxonomy, applied } = apply(t, {
      kind: 'add-subcategory',
      parent: 'amplifiers',
      slug: 'phono-stages',
      name: 'Phono stages',
      description: 'Raise and equalize a turntable cartridge’s signal',
      implies: ['pre-amp'],
      scopeClause: 'amplifiers',
    });
    expect(taxonomy.version).toBe(2);
    expect(taxonomy.migrations).toEqual([]);
    expect(findItem(taxonomy, 'shelf', 'phono-stages')).toMatchObject({
      parentId: findItem(t, 'shelf', 'amplifiers')!.id,
      implies: [findItem(t, 'function', 'pre-amp')!.id],
      sortOrder: 4,
      retiredIn: null,
    });
    expect(applied[0]).toMatchObject({
      created: [findItem(taxonomy, 'shelf', 'phono-stages')!.id],
      summary: 'Add Phono stages under Amplifiers',
    });
    // The original is left as it was.
    expect(findItem(t, 'shelf', 'phono-stages')).toBeUndefined();
  });

  it('leaves a category’s first subcategories to a split, and records the split', () => {
    const t = base();
    const refused = applyChanges(
      t,
      [
        {
          kind: 'add-subcategory',
          parent: 'dacs',
          slug: 'desktop',
          name: 'Desktop',
          description: 'For a desk',
          implies: [],
          scopeClause: 'DACs',
        },
      ],
      ids,
    );
    expect(refused).toEqual({
      ok: false,
      issues: [
        'changes.0: DACs has no subcategories yet: its first ones are a split, which is the owner’s.',
      ],
    });
    const { taxonomy } = apply(t, {
      kind: 'split',
      item: 'dacs',
      children: [
        { slug: 'desktop-dacs', name: 'Desktop', description: 'For a desk', implies: ['dac'] },
        { slug: 'portable-dacs', name: 'Portable', description: 'To carry', implies: ['dac'] },
      ],
      scopeClause: 'DACs',
    });
    expect(taxonomy.migrations).toEqual([
      {
        version: 2,
        kind: 'split',
        subject: 'shelf',
        from: findItem(t, 'shelf', 'dacs')!.id,
        to: [
          findItem(taxonomy, 'shelf', 'desktop-dacs')!.id,
          findItem(taxonomy, 'shelf', 'portable-dacs')!.id,
        ],
      },
    ]);
  });

  it('merges a shelf into another: retired, migrated, and resolved to its target', () => {
    const t = base();
    const preamps = findItem(t, 'shelf', 'preamps')!.id;
    const power = findItem(t, 'shelf', 'power-amps')!.id;
    const { taxonomy, applied } = apply(t, {
      kind: 'merge',
      subject: 'shelf',
      from: 'preamps',
      into: 'power-amps',
    });
    expect(findItem(taxonomy, 'shelf', preamps)!.retiredIn).toBe(2);
    expect(taxonomy.migrations).toEqual([
      { version: 2, kind: 'merge', subject: 'shelf', from: preamps, to: power },
    ]);
    expect(resolveId(taxonomy, 'shelf', preamps)).toBe(power);
    expect(applied[0]!.change).toEqual({
      kind: 'merge',
      subject: 'shelf',
      from: preamps,
      into: power,
    });
  });

  it('renames in place, keeping the ID, and lists the rename for history', () => {
    const t = base();
    const power = findItem(t, 'shelf', 'power-amps')!;
    const { taxonomy } = apply(t, {
      kind: 'rename',
      subject: 'shelf',
      item: power.id,
      name: 'Power amplifiers',
    });
    expect(findItem(taxonomy, 'shelf', power.id)).toMatchObject({
      slug: 'power-amps',
      name: 'Power amplifiers',
    });
    expect(taxonomy.migrations).toEqual([
      { version: 2, kind: 'rename', subject: 'shelf', from: power.id, to: power.id },
    ]);
  });

  it('retires a feature’s only shelf, which leaves the feature on none and still exports', () => {
    const t = base();
    const { taxonomy } = apply(
      t,
      { kind: 'retire', subject: 'shelf', item: 'over-ear' },
      { kind: 'retire', subject: 'shelf', item: 'on-ear' },
      { kind: 'retire', subject: 'shelf', item: 'headphones' },
    );
    expect(taxonomyIssues(taxonomy)).toEqual([]);
    expect(findItem(taxonomy, 'feature', 'back')).toMatchObject({ retiredIn: null });
    const exported = exportTaxonomy(taxonomy);
    expect(exported.features.find((feature) => feature.slug === 'back')?.shelves).toEqual([]);
    expect(seedTaxonomy(exported, ids).ok).toBe(true);
  });

  it('retires a feature with its values, and refuses to retire a feature’s last value', () => {
    const t = base();
    const { taxonomy } = apply(t, { kind: 'retire', subject: 'feature', item: 'back' });
    expect(findItem(taxonomy, 'feature', 'back')!.retiredIn).toBe(2);
    expect(findItem(taxonomy, 'value', 'open')!.retiredIn).toBe(2);
    const once = apply(t, { kind: 'retire', subject: 'value', item: 'open' }).taxonomy;
    expect(applyChanges(once, [{ kind: 'retire', subject: 'value', item: 'closed' }], ids)).toEqual(
      {
        ok: false,
        issues: ['changes.0: Closed is Back’s last live value: retire the feature instead.'],
      },
    );
  });

  it('refuses what would break the taxonomy: a third level, a name twice among siblings, nothing named', () => {
    const t = base();
    expect(
      applyChanges(t, [{ kind: 'move', item: 'headphone-amps', parent: 'over-ear' }], ids),
    ).toEqual({
      ok: false,
      issues: ['changes.0: Over-ear is a subcategory: a subcategory moves to a category.'],
    });
    const twice = applyChanges(
      t,
      [
        {
          kind: 'add-subcategory',
          parent: 'amplifiers',
          slug: 'power-amps-2',
          name: 'Power amps',
          description: 'Again',
          implies: [],
          scopeClause: 'amplifiers',
        },
      ],
      ids,
    );
    expect(twice.ok).toBe(false);
    if (!twice.ok)
      expect(twice.issues.join('\n')).toContain('Another live sibling is also named Power amps.');
    expect(
      applyChanges(
        t,
        [{ kind: 'describe', subject: 'shelf', item: 'nowhere', description: 'x' }],
        ids,
      ),
    ).toEqual({
      ok: false,
      issues: ['changes.0: There’s no live shelf nowhere.'],
    });
  });
});

describe('inverseChanges', () => {
  it.each<[string, TaxonomyChange]>([
    ['a merge', { kind: 'merge', subject: 'shelf', from: 'preamps', into: 'power-amps' }],
    [
      'a rename with its slug',
      {
        kind: 'rename',
        subject: 'value',
        item: 'iems',
        name: 'In-ear monitors',
        slug: 'in-ear-monitors',
      },
    ],
    [
      'a new feature',
      {
        kind: 'add-feature',
        slug: 'power',
        name: 'Power',
        description: 'Its amplification',
        cardinality: 'one',
        shelves: ['amplifiers'],
        values: [{ slug: 'active', name: 'Active', description: 'Built-in amplification' }],
      },
    ],
    [
      'a description',
      { kind: 'describe', subject: 'feature', item: 'drives', description: 'What it can drive' },
    ],
    [
      'a split',
      {
        kind: 'split',
        item: 'dacs',
        children: [
          { slug: 'desktop-dacs', name: 'Desktop', description: 'For a desk', implies: [] },
        ],
        scopeClause: 'DACs',
      },
    ],
    ['what a shelf implies', { kind: 'implies', shelf: 'dacs', implies: ['dac', 'amplifier'] }],
    ['the scope', { kind: 'scope', scope: 'Hi-fi made for audio, and nothing else.' }],
    ['a retired feature', { kind: 'retire', subject: 'feature', item: 'back' }],
    ['a retired subcategory', { kind: 'retire', subject: 'shelf', item: 'on-ear' }],
    ['a merged value', { kind: 'merge', subject: 'value', from: 'iems', into: 'speakers' }],
    ['a move', { kind: 'move', item: 'over-ear', parent: 'amplifiers' }],
    [
      'a new subcategory',
      {
        kind: 'add-subcategory',
        parent: 'amplifiers',
        slug: 'phono-stages',
        name: 'Phono stages',
        description: 'Raise a cartridge’s signal',
        implies: ['pre-amp'],
        scopeClause: 'amplifiers',
      },
    ],
  ])('undoes %s as a new version, leaving the items as they were', (_, change) => {
    const t = base();
    const forward = apply(t, change);
    const back = apply(forward.taxonomy, ...inverseChanges(forward.applied));
    expect(back.taxonomy.version).toBe(3);
    expect(items(back.taxonomy)).toEqual(items(t));
    // History is never rewritten: the forward change's migration stays listed.
    expect(back.taxonomy.migrations.slice(0, forward.taxonomy.migrations.length)).toEqual(
      forward.taxonomy.migrations,
    );
  });
});

describe('the rules around changes', () => {
  it('lets only the earnable kinds earn autonomy, and keeps describing a function the owner’s', () => {
    expect(
      autonomyKind({
        kind: 'add-value',
        feature: 'drives',
        slug: 'x',
        name: 'X',
        description: 'X',
      }),
    ).toBe('add-value');
    expect(
      autonomyKind({ kind: 'describe', subject: 'shelf', item: 'dacs', description: 'x' }),
    ).toBe('describe');
    expect(
      autonomyKind({ kind: 'describe', subject: 'function', item: 'dac', description: 'x' }),
    ).toBeNull();
    expect(autonomyKind({ kind: 'merge', subject: 'shelf', from: 'a', into: 'b' })).toBeNull();
  });

  it('records a restore when undoing a merge or a retirement: live again, its to repeating its from', () => {
    const t = base();
    const preamps = findItem(t, 'shelf', 'preamps')!.id;
    const merged = apply(t, {
      kind: 'merge',
      subject: 'shelf',
      from: 'preamps',
      into: 'power-amps',
    });
    const undone = apply(merged.taxonomy, ...inverseChanges(merged.applied)).taxonomy;
    expect(undone.migrations.at(-1)).toEqual({
      version: 3,
      kind: 'restore',
      subject: 'shelf',
      from: preamps,
      to: preamps,
    });
    expect(findItem(undone, 'shelf', preamps)!.retiredIn).toBeNull();
    expect(resolveId(undone, 'shelf', preamps)).toBe(preamps);
    expect(taxonomyIssues(undone)).toEqual([]);
    const back = findItem(t, 'feature', 'back')!.id;
    const retired = apply(t, { kind: 'retire', subject: 'feature', item: 'back' });
    expect(
      apply(retired.taxonomy, ...inverseChanges(retired.applied)).taxonomy.migrations.at(-1),
    ).toEqual({
      version: 3,
      kind: 'restore',
      subject: 'feature',
      from: back,
      to: back,
    });
    // A merge whose item is live again, with no restore after it, isn't a taxonomy a reader can follow.
    expect(taxonomyIssues({ ...undone, migrations: undone.migrations.slice(0, 1) })).toContainEqual(
      expect.objectContaining({
        message: `${preamps} is live, and its last migration retires it.`,
      }),
    );
  });

  it('takes no restore from outside: only undoing makes one', () => {
    expect(
      changeSchema.safeParse({ kind: 'restore', subject: 'shelf', item: 'dacs' }).success,
    ).toBe(false);
    expect(
      changeSchema.safeParse({ kind: 'retire', subject: 'shelf', item: 'dacs', extra: 1 }).success,
    ).toBe(false);
  });

  it('finds a clause in the scope’s in-scope part only', () => {
    const scope =
      'Hi-fi made for audio: headphones, DACs, and amplifiers. Out of scope: accessories (cables, stands).';
    expect(inScope(scope, 'amplifiers')).toBe(true);
    expect(inScope(scope, 'DACs,  and amplifiers')).toBe(true);
    expect(inScope(scope, 'cables')).toBe(false);
    expect(inScope(scope, 'turntables')).toBe(false);
    expect(inScope(scope, 'a')).toBe(false);
  });
});
