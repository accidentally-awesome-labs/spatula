import { z } from 'zod';
import {
  featureOfValue,
  findItem,
  isLive,
  scopeSchema,
  shelfById,
  subcategoriesOf,
  TAXONOMY_SUBJECTS,
  taxonomyDescriptionSchema,
  taxonomyIssues,
  taxonomyNameSchema,
  taxonomySlugSchema,
  type Feature,
  type MigrationKind,
  type Shelf,
  type Taxonomy,
  type TaxonomyItem,
  type TaxonomySubject,
} from './taxonomy';

/*
 * Changes to a taxonomy (ADR 0007), each a typed record that code applies. A change names items by
 * ID or slug. A batch of changes makes the next version. Renames, moves, merges, splits,
 * retirements, and restores record their migration, which tells readers how values move, and every change keeps
 * what undoing it needs. Nothing is deleted: a retired item stays listed, and undoing applies the
 * inverse as another version. Only undoing restores an item.
 */

export const CHANGE_KINDS = [
  'add-category',
  'add-subcategory',
  'add-function',
  'add-feature',
  'add-value',
  'describe',
  'rename',
  'move',
  'merge',
  'split',
  'retire',
  'implies',
  'scope',
  'restore',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * The kinds that can apply on their own, once the owner has accepted enough of them unedited. A
 * description is not one (ADR 0007): its text reaches later prompts as trusted text.
 */
export const EARNABLE_KINDS: readonly ChangeKind[] = [
  'add-subcategory',
  'add-feature',
  'add-value',
];
/** The kinds a consumer's `taxonomy:approve-additive` scope approves. */
export const ADDITIVE_KINDS: readonly ChangeKind[] = [
  'add-subcategory',
  'add-feature',
  'add-value',
];
/** Unedited acceptances in a row that earn a kind its autonomy. */
export const AUTONOMY_AFTER = 10;

const ref = z.string().trim().min(1).max(64);
const newItem = {
  slug: taxonomySlugSchema,
  name: taxonomyNameSchema,
  description: taxonomyDescriptionSchema,
};
const subject = z.enum(TAXONOMY_SUBJECTS);
/** The words of the scope statement's in-scope part a new shelf rests on. */
const scopeClause = z.string().trim().min(3).max(300);
const implies = z.array(ref).max(50).default([]);

/** A change as a proposal, a person, or the API may send it: every kind but restore. */
export const changeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('add-category'), ...newItem, implies, scopeClause }),
  z.strictObject({
    kind: z.literal('add-subcategory'),
    parent: ref,
    ...newItem,
    implies,
    scopeClause,
  }),
  z.strictObject({ kind: z.literal('add-function'), ...newItem }),
  z.strictObject({
    kind: z.literal('add-feature'),
    ...newItem,
    cardinality: z.enum(['one', 'many']),
    shelves: z.array(ref).min(1).max(50),
    values: z.array(z.strictObject(newItem)).min(1).max(50),
  }),
  z.strictObject({ kind: z.literal('add-value'), feature: ref, ...newItem }),
  z.strictObject({
    kind: z.literal('describe'),
    subject,
    item: ref,
    description: taxonomyDescriptionSchema,
  }),
  z.strictObject({
    kind: z.literal('rename'),
    subject,
    item: ref,
    name: taxonomyNameSchema,
    slug: taxonomySlugSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('move'), item: ref, parent: ref }),
  z.strictObject({
    kind: z.literal('merge'),
    subject: z.enum(['shelf', 'function', 'value']),
    from: ref,
    into: ref,
  }),
  z.strictObject({
    kind: z.literal('split'),
    item: ref,
    children: z
      .array(z.strictObject({ ...newItem, implies }))
      .min(1)
      .max(20),
    scopeClause,
  }),
  z.strictObject({ kind: z.literal('retire'), subject, item: ref }),
  z.strictObject({ kind: z.literal('implies'), shelf: ref, implies: z.array(ref).max(50) }),
  z.strictObject({ kind: z.literal('scope'), scope: scopeSchema }),
]);
export type ProposableChange = z.output<typeof changeSchema>;
export type TaxonomyChange =
  | ProposableChange
  | { kind: 'restore'; subject: TaxonomySubject; item: string };

/** What a change replaced, which undoing it puts back. */
export interface ChangeBefore {
  name?: string;
  slug?: string;
  description?: string;
  parentId?: string | null;
  implies?: string[];
  scope?: string;
}

export interface AppliedChange {
  /** The change, with every item it names written as an ID. */
  change: TaxonomyChange;
  /** The IDs it made, in order. */
  created: string[];
  before: ChangeBefore | null;
  /** The change in words, as the console and a run's summary show it. */
  summary: string;
}

/**
 * Applies a batch of changes as the next version, or says why it can't: a change that names nothing,
 * or a taxonomy that would break (a third level, a name twice among live siblings, a slug twice).
 * The taxonomy given is left as it was.
 */
export function applyChanges(
  taxonomy: Taxonomy,
  changes: readonly TaxonomyChange[],
  makeId: () => string,
): { ok: true; taxonomy: Taxonomy; applied: AppliedChange[] } | { ok: false; issues: string[] } {
  if (changes.length === 0) return { ok: false, issues: ['There’s no change to apply.'] };
  // A taxonomy is plain JSON, so a copy through JSON is a whole copy.
  const next = JSON.parse(JSON.stringify(taxonomy)) as Taxonomy;
  next.version = taxonomy.version + 1;
  const applied: AppliedChange[] = [];
  const issues: string[] = [];
  changes.forEach((change, index) => {
    const result = applyOne(next, change, makeId);
    if (typeof result === 'string') issues.push(`changes.${index}: ${result}`);
    else applied.push(result);
  });
  if (issues.length === 0) {
    issues.push(
      ...taxonomyIssues(next).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, taxonomy: next, applied };
}

/** One change, applied in place, or why it can't be. */
function applyOne(
  t: Taxonomy,
  change: TaxonomyChange,
  makeId: () => string,
): AppliedChange | string {
  const version = t.version;
  const migrate = (
    kind: MigrationKind,
    about: TaxonomySubject,
    from: string,
    to: string | string[] | null,
  ) => {
    t.migrations.push({ version, kind, subject: about, from, to });
  };
  const liveItem = (about: TaxonomySubject, itemRef: string): TaxonomyItem | string => {
    const found = findItem(t, about, itemRef);
    return found !== undefined && isLive(found) ? found : `There’s no live ${about} ${itemRef}.`;
  };
  const liveFunctions = (refs: readonly string[]): string[] | string => {
    const found: string[] = [];
    for (const itemRef of refs) {
      const fn = liveItem('function', itemRef);
      if (typeof fn === 'string') return fn;
      found.push(fn.id);
    }
    return found;
  };
  const nextPlace = (list: readonly { sortOrder: number }[]) =>
    list.reduce((most, entry) => Math.max(most, entry.sortOrder), 0) + 1;
  const newShelf = (
    fields: { slug: string; name: string; description: string },
    parentId: string | null,
    shelfImplies: string[],
  ): Shelf => ({
    id: makeId(),
    slug: fields.slug,
    name: fields.name,
    description: fields.description,
    parentId,
    implies: shelfImplies,
    sortOrder: nextPlace(t.shelves.filter((shelf) => shelf.parentId === parentId)),
    retiredIn: null,
  });
  const done = (
    resolved: TaxonomyChange,
    created: string[],
    before: ChangeBefore | null,
    summary: string,
  ): AppliedChange => ({ change: resolved, created, before, summary });

  switch (change.kind) {
    case 'add-category': {
      const fns = liveFunctions(change.implies);
      if (typeof fns === 'string') return fns;
      const shelf = newShelf(change, null, fns);
      t.shelves.push(shelf);
      return done({ ...change, implies: fns }, [shelf.id], null, `Add the category ${shelf.name}`);
    }
    case 'add-subcategory': {
      const parent = liveItem('shelf', change.parent);
      if (typeof parent === 'string') return parent;
      if ((parent as Shelf).parentId !== null) {
        return `${parent.name} is a subcategory: shelves go two levels deep at most.`;
      }
      if (subcategoriesOf(t, parent.id).length === 0) {
        return `${parent.name} has no subcategories yet: its first ones are a split, which is the owner’s.`;
      }
      const fns = liveFunctions(change.implies);
      if (typeof fns === 'string') return fns;
      const shelf = newShelf(change, parent.id, fns);
      t.shelves.push(shelf);
      return done(
        { ...change, parent: parent.id, implies: fns },
        [shelf.id],
        null,
        `Add ${shelf.name} under ${parent.name}`,
      );
    }
    case 'add-function': {
      const fn = {
        id: makeId(),
        slug: change.slug,
        name: change.name,
        description: change.description,
        sortOrder: nextPlace(t.functions),
        retiredIn: null,
      };
      t.functions.push(fn);
      return done(change, [fn.id], null, `Add the function ${fn.name}`);
    }
    case 'add-feature': {
      const shelves: string[] = [];
      for (const itemRef of change.shelves) {
        const shelf = liveItem('shelf', itemRef);
        if (typeof shelf === 'string') return shelf;
        shelves.push(shelf.id);
      }
      const feature: Feature = {
        id: makeId(),
        slug: change.slug,
        name: change.name,
        description: change.description,
        cardinality: change.cardinality,
        shelves,
        sortOrder: nextPlace(t.features),
        retiredIn: null,
        values: change.values.map((value, index) => ({
          id: makeId(),
          slug: value.slug,
          name: value.name,
          description: value.description,
          sortOrder: index + 1,
          retiredIn: null,
        })),
      };
      t.features.push(feature);
      return done(
        { ...change, shelves },
        [feature.id, ...feature.values.map((value) => value.id)],
        null,
        `Add the feature ${feature.name}: ${feature.values.map((value) => value.name).join(', ')}`,
      );
    }
    case 'add-value': {
      const found = liveItem('feature', change.feature);
      if (typeof found === 'string') return found;
      const feature = found as Feature;
      const value = {
        id: makeId(),
        slug: change.slug,
        name: change.name,
        description: change.description,
        sortOrder: nextPlace(feature.values),
        retiredIn: null,
      };
      feature.values.push(value);
      return done(
        { ...change, feature: feature.id },
        [value.id],
        null,
        `Add ${value.name} to ${feature.name}`,
      );
    }
    case 'describe': {
      const found = liveItem(change.subject, change.item);
      if (typeof found === 'string') return found;
      const before = { description: found.description };
      found.description = change.description;
      return done({ ...change, item: found.id }, [], before, `Describe ${found.name} anew`);
    }
    case 'rename': {
      const found = liveItem(change.subject, change.item);
      if (typeof found === 'string') return found;
      const before: ChangeBefore = {
        name: found.name,
        ...(change.slug === undefined ? {} : { slug: found.slug }),
      };
      const old = found.name;
      found.name = change.name;
      if (change.slug !== undefined) found.slug = change.slug;
      migrate('rename', change.subject, found.id, found.id);
      return done({ ...change, item: found.id }, [], before, `Rename ${old} to ${found.name}`);
    }
    case 'move': {
      const found = liveItem('shelf', change.item);
      if (typeof found === 'string') return found;
      const shelf = found as Shelf;
      if (shelf.parentId === null) return `${shelf.name} is a category: only a subcategory moves.`;
      const parent = liveItem('shelf', change.parent);
      if (typeof parent === 'string') return parent;
      if ((parent as Shelf).parentId !== null) {
        return `${parent.name} is a subcategory: a subcategory moves to a category.`;
      }
      if (parent.id === shelf.parentId) return `${shelf.name} is under ${parent.name} already.`;
      const before = { parentId: shelf.parentId };
      shelf.sortOrder = nextPlace(t.shelves.filter((entry) => entry.parentId === parent.id));
      shelf.parentId = parent.id;
      migrate('move', 'shelf', shelf.id, shelf.id);
      return done(
        { ...change, item: shelf.id, parent: parent.id },
        [],
        before,
        `Move ${shelf.name} under ${parent.name}`,
      );
    }
    case 'merge': {
      const from = liveItem(change.subject, change.from);
      if (typeof from === 'string') return from;
      const into = liveItem(change.subject, change.into);
      if (typeof into === 'string') return into;
      if (from.id === into.id) return 'An item can’t be merged into itself.';
      if (change.subject === 'shelf' && subcategoriesOf(t, from.id).length > 0) {
        return `Move or merge ${from.name}’s subcategories first.`;
      }
      if (
        change.subject === 'value' &&
        featureOfValue(t, from.id)?.id !== featureOfValue(t, into.id)?.id
      ) {
        return 'Values merge within their feature.';
      }
      if (
        change.subject === 'function' &&
        t.shelves.some((shelf) => isLive(shelf) && shelf.implies.includes(from.id))
      ) {
        return `Shelves imply ${from.name}: change what they imply first.`;
      }
      from.retiredIn = version;
      migrate('merge', change.subject, from.id, into.id);
      return done(
        { ...change, from: from.id, into: into.id },
        [],
        null,
        `Merge ${from.name} into ${into.name}`,
      );
    }
    case 'split': {
      const found = liveItem('shelf', change.item);
      if (typeof found === 'string') return found;
      if ((found as Shelf).parentId !== null)
        return `${found.name} is a subcategory: only a category splits.`;
      if (subcategoriesOf(t, found.id).length > 0) {
        return `${found.name} has subcategories already: add another with add-subcategory.`;
      }
      const created: string[] = [];
      const children = [];
      for (const child of change.children) {
        const fns = liveFunctions(child.implies);
        if (typeof fns === 'string') return fns;
        const shelf = newShelf(child, found.id, fns);
        t.shelves.push(shelf);
        created.push(shelf.id);
        children.push({ ...child, implies: fns });
      }
      migrate('split', 'shelf', found.id, created);
      return done(
        { ...change, item: found.id, children },
        created,
        null,
        `Split ${found.name} into ${change.children.map((child) => child.name).join(', ')}`,
      );
    }
    case 'retire': {
      const found = liveItem(change.subject, change.item);
      if (typeof found === 'string') return found;
      if (change.subject === 'shelf' && subcategoriesOf(t, found.id).length > 0) {
        return `Retire or move ${found.name}’s subcategories first.`;
      }
      if (
        change.subject === 'function' &&
        t.shelves.some((shelf) => isLive(shelf) && shelf.implies.includes(found.id))
      ) {
        return `Shelves imply ${found.name}: change what they imply first.`;
      }
      if (change.subject === 'value') {
        const feature = featureOfValue(t, found.id);
        if (feature !== undefined && feature.values.filter(isLive).length === 1) {
          return `${found.name} is ${feature.name}’s last live value: retire the feature instead.`;
        }
      }
      found.retiredIn = version;
      if (change.subject === 'feature') {
        for (const value of (found as Feature).values) if (isLive(value)) value.retiredIn = version;
      }
      migrate('retire', change.subject, found.id, null);
      return done({ ...change, item: found.id }, [], null, `Retire ${found.name}`);
    }
    case 'implies': {
      const found = liveItem('shelf', change.shelf);
      if (typeof found === 'string') return found;
      const fns = liveFunctions(change.implies);
      if (typeof fns === 'string') return fns;
      const shelf = found as Shelf;
      const before = { implies: [...shelf.implies] };
      shelf.implies = fns;
      return done(
        { ...change, shelf: shelf.id, implies: fns },
        [],
        before,
        `Change what ${shelf.name} implies`,
      );
    }
    case 'scope': {
      const before = { scope: t.scope };
      t.scope = change.scope;
      return done(change, [], before, 'Change the scope statement');
    }
    case 'restore': {
      const found = findItem(t, change.subject, change.item);
      if (found === undefined || isLive(found))
        return `There’s no retired ${change.subject} ${change.item}.`;
      if (change.subject === 'shelf') {
        const parentId = (found as Shelf).parentId;
        const parent = parentId === null ? undefined : shelfById(t, parentId);
        if (parentId !== null && (parent === undefined || !isLive(parent))) {
          return `Bring back ${found.name}’s category first.`;
        }
      }
      if (change.subject === 'value') {
        const feature = featureOfValue(t, found.id);
        if (feature === undefined || !isLive(feature))
          return `Bring back ${found.name}’s feature first.`;
      }
      const retiredIn = found.retiredIn;
      found.retiredIn = null;
      if (change.subject === 'feature') {
        for (const value of (found as Feature).values)
          if (value.retiredIn === retiredIn) value.retiredIn = null;
      }
      // The contract's restore: live again, and its to repeats its from. Records point back at it
      // through their own values (ruling 5), so nothing else moves.
      migrate('restore', change.subject, found.id, found.id);
      return done({ ...change, item: found.id }, [], null, `Bring back ${found.name}`);
    }
  }
}

/**
 * The changes that undo these, in reverse order: what was added is retired, what was merged or
 * retired comes back, and what was replaced is put back.
 */
export function inverseChanges(applied: readonly AppliedChange[]): TaxonomyChange[] {
  return [...applied].reverse().flatMap(({ change, created, before }): TaxonomyChange[] => {
    switch (change.kind) {
      case 'add-category':
      case 'add-subcategory':
      case 'split':
        return created.map((item) => ({ kind: 'retire', subject: 'shelf', item }));
      case 'add-function':
        return [{ kind: 'retire', subject: 'function', item: created[0]! }];
      case 'add-feature':
        return [{ kind: 'retire', subject: 'feature', item: created[0]! }];
      case 'add-value':
        return [{ kind: 'retire', subject: 'value', item: created[0]! }];
      case 'describe':
        return [
          {
            kind: 'describe',
            subject: change.subject,
            item: change.item,
            description: before!.description!,
          },
        ];
      case 'rename':
        return [
          {
            kind: 'rename',
            subject: change.subject,
            item: change.item,
            name: before!.name!,
            ...(before!.slug === undefined ? {} : { slug: before!.slug }),
          },
        ];
      case 'move':
        return [{ kind: 'move', item: change.item, parent: before!.parentId! }];
      case 'merge':
        return [{ kind: 'restore', subject: change.subject, item: change.from }];
      case 'retire':
        return [{ kind: 'restore', subject: change.subject, item: change.item }];
      case 'implies':
        return [{ kind: 'implies', shelf: change.shelf, implies: before!.implies! }];
      case 'scope':
        return [{ kind: 'scope', scope: before!.scope! }];
      case 'restore':
        return [{ kind: 'retire', subject: change.subject, item: change.item }];
    }
  });
}

/**
 * The kind a change earns autonomy as, or null for a change that is always the owner's. A
 * description is never earnable, whatever it describes: a change Spatula applies on its own puts
 * its text into the taxonomy, which later decider and review prompts trust, and a description is
 * the freest text of the kinds that could earn it, with no new item and no page count behind it
 * (ADR 0007). It applies only on the owner's approval.
 */
export function autonomyKind(change: TaxonomyChange): ChangeKind | null {
  return EARNABLE_KINDS.includes(change.kind) ? change.kind : null;
}

/**
 * Whether a clause quotes the scope statement's in-scope part, and not its out-of-scope part. The
 * in-scope part is everything before "Out of scope"; case and spacing don't matter.
 */
export function inScope(scope: string, clause: string): boolean {
  const flat = (text: string) => text.toLowerCase().replace(/\s+/gu, ' ').trim();
  const text = flat(scope);
  const quoted = flat(clause);
  if (quoted.length < 3) return false;
  const cut = text.indexOf('out of scope');
  const inside = cut === -1 ? text : text.slice(0, cut);
  const outside = cut === -1 ? '' : text.slice(cut);
  return inside.includes(quoted) && !outside.includes(quoted);
}
