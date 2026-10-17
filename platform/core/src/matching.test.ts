import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
import type { FieldValue } from './fields';
import { identityClaims } from './identity';
import {
  claimLabel,
  contestedNames,
  identifiersDisagree,
  mergeValues,
  nameScope,
  planMatch,
  type MatchVerdict,
} from './matching';

const parsed = parseDefinition({
  dataset: 'audio-products',
  recordTypes: {
    product: {
      identity: { identifiers: ['gtins', 'mpns'], keys: [['brand', 'name']] },
      fields: {
        brand: { type: 'text', required: true },
        name: { type: 'text', required: true },
        gtins: { type: 'gtin', list: true, identifier: true },
        mpns: { type: 'text', list: true, identifier: true, scope: 'brand' },
      },
    },
  },
  sources: [
    {
      id: 'maker',
      kind: 'pages',
      recordType: 'product',
      pages: ['https://maker.example/a'],
      evidence: {
        robots: '2026-10-09',
        terms: {
          url: 'https://maker.example/terms',
          checked: '2026-10-09',
          automatedAccess: 'allowed',
        },
      },
    },
  ],
});
if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
const product = parsed.definition.recordTypes.product as RecordType;

type Values = Record<string, FieldValue[]>;
const DT_80: Values = { brand: ['beyerdynamic'], name: ['DT 770 PRO'], gtins: ['04010118471063'] };
const DT_250: Values = { brand: ['beyerdynamic'], name: ['DT 770 PRO'], gtins: ['04010118471070'] };

/** The owners of an entity's claims, as resolution records them. */
const owning = (entityId: string, values: Values) =>
  new Map(identityClaims(product, values).map((claim) => [claim.value, entityId]));

/** The claims a record makes on its name: those that no identifier gives. */
const nameClaims = (values: Values) =>
  identityClaims(product, values)
    .filter((claim) => claim.rank >= product.identity.identifiers.length)
    .map((claim) => claim.value);

const plan = (
  values: Values,
  others: Record<string, Values> = {},
  verdicts: Record<string, MatchVerdict> = {},
  contested: boolean | string[] = false,
  people: string[] = [],
) => {
  const owners = new Map<string, string>();
  const scope = nameScope(product, values)?.scope;
  const sameScope: { id: string; names: string[] }[] = [];
  for (const [id, theirs] of Object.entries(others)) {
    for (const [claim, owner] of owning(id, theirs))
      if (!owners.has(claim)) owners.set(claim, owner);
    const named = nameScope(product, theirs);
    if (named !== null && named.scope === scope) sameScope.push({ id, names: [named.name] });
  }
  return planMatch({
    recordType: product,
    values,
    owners,
    identifiers: new Map(Object.entries(others)),
    sameScope,
    verdicts: new Map(Object.entries(verdicts)),
    contested: new Set(contested === true ? nameClaims(values) : contested || []),
    byPerson: new Set(people),
  });
};

describe('planMatch', () => {
  it('can’t place a record with nothing to identify it by', () => {
    expect(plan({ brand: ['beyerdynamic'] })).toEqual({ kind: 'unresolvable' });
  });

  it('joins on an identifier, whatever the names say', () => {
    const renamed = { ...DT_80, name: ['DT 770 PRO (2024)'] };
    expect(plan(renamed, { sp_e1: DT_80 })).toEqual({ kind: 'join', entityId: 'sp_e1' });
  });

  it('joins on a name when no identifiers disagree, and asks when they do', () => {
    const noGtin = { brand: ['beyerdynamic'], name: ['DT 770 PRO'] };
    expect(plan(noGtin, { sp_e1: DT_80 })).toEqual({ kind: 'join', entityId: 'sp_e1' });
    expect(plan(DT_250, { sp_e1: DT_80 })).toEqual({ kind: 'ask', entityIds: ['sp_e1'] });
  });

  it('follows verdicts: same joins, not the same keeps apart, and unsure waits', () => {
    expect(plan(DT_250, { sp_e1: DT_80 }, { sp_e1: 'same' })).toEqual({
      kind: 'join',
      entityId: 'sp_e1',
    });
    expect(plan(DT_250, { sp_e1: DT_80 }, { sp_e1: 'not_same' })).toEqual({ kind: 'create' });
    expect(plan(DT_250, { sp_e1: DT_80 }, { sp_e1: 'unsure' })).toEqual({ kind: 'wait' });
  });

  it('asks about the closest similar names within the brand before starting an entity', () => {
    const page = { brand: ['Sennheiser'], name: ['HD 660S2'] };
    const others = {
      sp_e1: { brand: ['Sennheiser'], name: ['HD 660S'] },
      sp_e2: { brand: ['Sennheiser'], name: ['HD 600'] },
      sp_e3: { brand: ['Focal'], name: ['HD 660S2 Pads'] },
    };
    expect(plan(page, others)).toEqual({ kind: 'ask', entityIds: ['sp_e1'] });
    expect(plan(page, others, { sp_e1: 'not_same' })).toEqual({ kind: 'create' });
    expect(plan(page, others, { sp_e1: 'unsure' })).toEqual({ kind: 'wait' });
    expect(plan({ brand: ['Sennheiser'], name: ['Momentum 4'] }, others)).toEqual({
      kind: 'create',
    });
  });

  it('asks about the similar names it hasn’t been told about yet, and one "same" settles it', () => {
    const page = { brand: ['Sennheiser'], name: ['HD 660S2'] };
    const others = {
      sp_e1: { brand: ['Sennheiser'], name: ['HD 660S'] },
      sp_e2: { brand: ['Sennheiser'], name: ['HD 660S2 Pro'] },
    };
    expect(plan(page, others)).toEqual({ kind: 'ask', entityIds: ['sp_e1', 'sp_e2'] });
    expect(plan(page, others, { sp_e1: 'not_same' })).toEqual({
      kind: 'ask',
      entityIds: ['sp_e2'],
    });
    expect(plan(page, others, { sp_e1: 'not_same', sp_e2: 'not_same' })).toEqual({
      kind: 'create',
    });
    expect(plan(page, others, { sp_e1: 'not_same', sp_e2: 'same' })).toEqual({
      kind: 'join',
      entityId: 'sp_e2',
    });
  });

  it('asks about at most three similar names, closest first', () => {
    // Against "HD 660S2": 0.7, 0.6, 0.6, and 0.69; "HD 660 S" scores 0.5 and isn't asked about.
    const others = Object.fromEntries(
      ['HD 660S', 'HD 660S2 Black', 'HD 660S2 Mk II', 'HD 660S2 Pro', 'HD 660 S'].map(
        (name, index) => [`sp_e${index}`, { brand: ['Sennheiser'], name: [name] }],
      ),
    );
    expect(plan({ brand: ['Sennheiser'], name: ['HD 660S2'] }, others)).toEqual({
      kind: 'ask',
      entityIds: ['sp_e0', 'sp_e3', 'sp_e1'],
    });
  });

  it('asks about the next closest name once the closest three are judged apart', () => {
    const others = Object.fromEntries(
      ['HD 660S', 'HD 660S2 Black', 'HD 660S2 Mk II', 'HD 660S2 Pro'].map((name, index) => [
        `sp_e${index}`,
        { brand: ['Sennheiser'], name: [name] },
      ]),
    );
    const page = { brand: ['Sennheiser'], name: ['HD 660S2'] };
    // The closest three are sp_e0, sp_e3, and sp_e1; sp_e2 is the fourth.
    expect(plan(page, others)).toEqual({ kind: 'ask', entityIds: ['sp_e0', 'sp_e3', 'sp_e1'] });
    const apart: Record<string, MatchVerdict> = {
      sp_e0: 'not_same',
      sp_e3: 'not_same',
      sp_e1: 'not_same',
    };
    expect(plan(page, others, apart)).toEqual({ kind: 'ask', entityIds: ['sp_e2'] });
    expect(plan(page, others, { ...apart, sp_e2: 'not_same' })).toEqual({ kind: 'create' });
  });

  it('starts its own entity for a page kept apart from the entity that owns its GTIN', () => {
    expect(plan(DT_80, { sp_e1: DT_80 }, { sp_e1: 'not_same' })).toEqual({ kind: 'create' });
  });

  describe('where several entities share the name', () => {
    // DT_250 was split off DT_80 by a "variant" answer. Both carry the name, and DT_80 owns its key.
    const named = { brand: ['beyerdynamic'], name: ['DT 770 PRO'] };
    const split = { sp_e1: DT_80, sp_e2: DT_250 };

    it('asks about all of them, not only the one that claimed the name first', () => {
      expect(plan(named, split)).toEqual({ kind: 'ask', entityIds: ['sp_e1', 'sp_e2'] });
      // The name is the same whatever its case and punctuation.
      expect(plan({ ...named, name: ['dt-770 Pro'] }, split)).toEqual({
        kind: 'ask',
        entityIds: ['sp_e1', 'sp_e2'],
      });
      // A third version's GTIN is no more help: it matches neither.
      const third = { ...named, gtins: ['04010118471087'] };
      expect(plan(third, split)).toEqual({ kind: 'ask', entityIds: ['sp_e1', 'sp_e2'] });
    });

    it('asks about at most three, the one that claimed the name first among them', () => {
      const four = {
        ...split,
        sp_e3: { ...DT_80, gtins: ['04010118471087'] },
        sp_e4: { ...DT_80, gtins: ['04010118471094'] },
      };
      expect(plan(named, four)).toEqual({ kind: 'ask', entityIds: ['sp_e1', 'sp_e2', 'sp_e3'] });
      const apart: Record<string, MatchVerdict> = {
        sp_e1: 'not_same',
        sp_e2: 'not_same',
        sp_e3: 'not_same',
      };
      expect(plan(named, four, apart)).toEqual({ kind: 'ask', entityIds: ['sp_e4'] });
      // The next three, once the owner is judged apart: the fourth is asked about with them.
      expect(plan(named, four, { sp_e1: 'not_same' })).toEqual({
        kind: 'ask',
        entityIds: ['sp_e2', 'sp_e3', 'sp_e4'],
      });
    });

    it('follows the verdicts it has been given about them', () => {
      expect(plan(named, split, { sp_e2: 'not_same' })).toEqual({
        kind: 'join',
        entityId: 'sp_e1',
      });
      expect(plan(named, split, { sp_e1: 'not_same' })).toEqual({
        kind: 'ask',
        entityIds: ['sp_e2'],
      });
      expect(plan(named, split, { sp_e1: 'not_same', sp_e2: 'not_same' })).toEqual({
        kind: 'create',
      });
      expect(plan(named, split, { sp_e2: 'same' })).toEqual({ kind: 'join', entityId: 'sp_e2' });
      expect(plan(named, split, { sp_e2: 'unsure' })).toEqual({ kind: 'wait' });
      expect(plan(named, split, { sp_e1: 'unsure' })).toEqual({ kind: 'wait' });
    });

    it('still joins the only entity with the name', () => {
      expect(plan(named, { sp_e1: DT_80 })).toEqual({ kind: 'join', entityId: 'sp_e1' });
      // An entity with another name in the same brand isn't asked about.
      const other = { brand: ['beyerdynamic'], name: ['DT 990 PRO'], gtins: ['04010118471094'] };
      expect(plan(named, { sp_e1: DT_80, sp_e3: other })).toEqual({
        kind: 'join',
        entityId: 'sp_e1',
      });
    });
  });

  describe('where verdicts say the page is the same as an entity', () => {
    const named = { brand: ['beyerdynamic'], name: ['DT 770 PRO'] };
    const split = { sp_e1: DT_80, sp_e2: DT_250 };

    it('joins the one entity a decider said it is, when nothing contradicts that', () => {
      expect(plan(named, split, { sp_e2: 'same' })).toEqual({ kind: 'join', entityId: 'sp_e2' });
      expect(plan(named, split, { sp_e1: 'not_same', sp_e2: 'same' })).toEqual({
        kind: 'join',
        entityId: 'sp_e2',
      });
    });

    it('waits while a question about the page waits for a person, whatever a decider said', () => {
      expect(plan(named, split, { sp_e1: 'same', sp_e2: 'unsure' })).toEqual({ kind: 'wait' });
    });

    it('waits for the question whatever the entities carry now, and starts no entity', () => {
      // Nothing else holds the page: no entity carries its name any longer.
      const verdicts: Record<string, MatchVerdict> = { sp_e1: 'same', sp_e2: 'unsure' };
      expect(plan(named, {}, verdicts)).toEqual({ kind: 'wait' });
      const unrelated = { sp_e3: { brand: ['beyerdynamic'], name: ['Amiron Home'] } };
      expect(plan(named, unrelated, verdicts)).toEqual({ kind: 'wait' });
    });

    it('joins the entity a person said it is, whatever else is said', () => {
      const both: Record<string, MatchVerdict> = { sp_e1: 'same', sp_e2: 'same' };
      expect(plan(named, split, both, false, ['sp_e2'])).toEqual({
        kind: 'join',
        entityId: 'sp_e2',
      });
      expect(plan(named, split, { sp_e1: 'same', sp_e2: 'unsure' }, false, ['sp_e1'])).toEqual({
        kind: 'join',
        entityId: 'sp_e1',
      });
    });

    it('is in dispute where several entities are said to be it, and one person didn’t choose', () => {
      const both: Record<string, MatchVerdict> = { sp_e1: 'same', sp_e2: 'same' };
      const dispute = { kind: 'dispute', entityIds: ['sp_e1', 'sp_e2'] };
      expect(plan(named, split, both)).toEqual(dispute);
      expect(plan(named, split, both, false, ['sp_e1', 'sp_e2'])).toEqual(dispute);
      // A person's "same" about an entity the page isn't judged the same as chooses nothing.
      expect(plan(named, split, both, false, ['sp_e9'])).toEqual(dispute);
    });
  });

  describe('where the name is contested', () => {
    const named = { brand: ['beyerdynamic'], name: ['DT 770 PRO'] };

    it('holds the page, rather than join an entity or start one on a name alone', () => {
      const held = { kind: 'hold', name: 'key0:beyerdynamic|dt770pro' };
      expect(plan(named, { sp_e1: DT_80 })).toEqual({ kind: 'join', entityId: 'sp_e1' });
      expect(plan(named, { sp_e1: DT_80 }, {}, true)).toEqual(held);
      expect(plan(named)).toEqual({ kind: 'create' });
      expect(plan(named, {}, {}, true)).toEqual(held);
    });

    it('waits as it did, not held, where it waits for a person already', () => {
      expect(plan(named, { sp_e1: DT_80 }, { sp_e1: 'unsure' }, true)).toEqual({ kind: 'wait' });
    });

    it('isn’t held by the contest over another name', () => {
      const other = ['key0:beyerdynamic|dt880pro'];
      expect(plan(named, { sp_e1: DT_80 }, {}, other)).toEqual({ kind: 'join', entityId: 'sp_e1' });
      expect(plan(named, {}, {}, other)).toEqual({ kind: 'create' });
    });

    it('still joins or starts an entity on an identifier, and joins on a verdict', () => {
      expect(plan(DT_80, { sp_e1: DT_80 }, {}, true)).toEqual({ kind: 'join', entityId: 'sp_e1' });
      expect(plan(DT_80, {}, {}, true)).toEqual({ kind: 'create' });
      expect(plan(named, { sp_e1: DT_80 }, { sp_e1: 'same' }, true)).toEqual({
        kind: 'join',
        entityId: 'sp_e1',
      });
    });

    it('waits instead of asking, so that what it does doesn’t depend on which entities exist yet', () => {
      const split = { sp_e1: DT_80, sp_e2: DT_250 };
      expect(plan(named, split)).toEqual({ kind: 'ask', entityIds: ['sp_e1', 'sp_e2'] });
      expect(plan(named, split, {}, true)).toMatchObject({ kind: 'hold' });
      const similar = { brand: ['Sennheiser'], name: ['HD 660S2'] };
      const others = { sp_e1: { brand: ['Sennheiser'], name: ['HD 660S'] } };
      expect(plan(similar, others)).toEqual({ kind: 'ask', entityIds: ['sp_e1'] });
      expect(plan(similar, others, {}, true)).toMatchObject({ kind: 'hold' });
    });

    it('still asks a page that gives identifiers', () => {
      expect(plan(DT_250, { sp_e1: DT_80 }, {}, true)).toEqual({
        kind: 'ask',
        entityIds: ['sp_e1'],
      });
      const third = { ...DT_250, gtins: ['04010118471087'] };
      expect(plan(third, { sp_e1: DT_80, sp_e2: DT_250 }, {}, true)).toEqual({
        kind: 'ask',
        entityIds: ['sp_e1', 'sp_e2'],
      });
    });
  });
});

describe('contestedNames', () => {
  const NAME = 'key0:beyerdynamic|dt770pro';
  const named = { brand: ['beyerdynamic'], name: ['DT 770 PRO'] };
  const BOTH: Values = { ...DT_80, gtins: ['04010118471063', '04010118471070'] };

  /** The names contested among pages that aren't joined yet, given the entities that own claims. */
  const contested = (
    pages: { values: Values; verdicts?: Record<string, MatchVerdict> }[],
    others: Record<string, Values> = {},
  ) => {
    const owners = new Map<string, string>();
    for (const [id, theirs] of Object.entries(others))
      for (const [claim, owner] of owning(id, theirs))
        if (!owners.has(claim)) owners.set(claim, owner);
    return [
      ...contestedNames({
        recordType: product,
        pages: pages.map(({ values, verdicts = {} }) => ({
          values,
          verdicts: new Map(Object.entries(verdicts)),
        })),
        owners,
        identifiers: new Map(Object.entries(others)),
      }),
    ];
  };

  it('contests a name that pages give different identifiers under', () => {
    expect(contested([{ values: DT_80 }, { values: DT_250 }])).toEqual([NAME]);
    // Any two disagreeing is enough: the first two agree here, and the third doesn't.
    const third = { ...DT_250, gtins: ['04010118471087'] };
    expect(contested([{ values: DT_80 }, { values: BOTH }, { values: third }])).toEqual([NAME]);
  });

  it('doesn’t, where they agree', () => {
    expect(contested([{ values: DT_80 }, { values: { ...DT_80, name: ['dt-770 pro'] } }])).toEqual(
      [],
    );
    expect(contested([{ values: DT_80 }, { values: BOTH }])).toEqual([]);
    expect(contested([{ values: DT_80 }])).toEqual([]);
  });

  it('compares them with the identifiers of the entity that owns the name', () => {
    expect(contested([{ values: DT_250 }], { sp_e1: DT_80 })).toEqual([NAME]);
    expect(contested([{ values: DT_80 }], { sp_e1: DT_80 })).toEqual([]);
    // An entity that gives no identifiers disagrees with nothing.
    expect(contested([{ values: DT_80 }], { sp_e1: named })).toEqual([]);
    expect(contested([{ values: DT_80 }, { values: DT_250 }], { sp_e1: named })).toEqual([NAME]);
  });

  it('counts only pages that give identifiers, and compares identifiers of a kind', () => {
    expect(contested([{ values: named }, { values: DT_80 }])).toEqual([]);
    expect(contested([{ values: named }], { sp_e1: DT_80 })).toEqual([]);
    // A part number and a GTIN can't disagree.
    const parted = { ...named, mpns: ['DT-770-250'] };
    expect(contested([{ values: parted }], { sp_e1: DT_80 })).toEqual([]);
    expect(contested([{ values: parted }, { values: DT_80 }])).toEqual([]);
    expect(contested([{ values: parted }, { values: { ...parted, mpns: ['DT-770-80'] } }])).toEqual(
      [NAME],
    );
  });

  it('keeps names apart, within a brand and between brands', () => {
    const other = { ...DT_250, name: ['DT 990 PRO'] };
    expect(contested([{ values: DT_80 }, { values: other }])).toEqual([]);
    expect(contested([{ values: DT_80 }, { values: { ...DT_250, brand: ['Focal'] } }])).toEqual([]);
  });

  it('contests a name while a page waits for an answer about the entity that owns it', () => {
    const waiting = (verdicts: Record<string, MatchVerdict>) =>
      contested([{ values: named, verdicts }], { sp_e1: DT_80 });
    expect(waiting({ sp_e1: 'unsure' })).toEqual([NAME]);
    // An answer isn't waiting, and neither is a question about another entity.
    expect(waiting({ sp_e1: 'same' })).toEqual([]);
    expect(waiting({ sp_e1: 'not_same' })).toEqual([]);
    expect(waiting({ sp_e9: 'unsure' })).toEqual([]);
    // Nobody owns the name, so there is no entity to wait on.
    expect(contested([{ values: named, verdicts: { sp_e1: 'unsure' } }])).toEqual([]);
  });
});

describe('the helpers', () => {
  it('compare names within their scope, and identifiers of a kind', () => {
    expect(nameScope(product, { brand: ['Sennheiser GmbH'], name: ['HD 650'] })).toEqual({
      scope: 'sennheisergmbh',
      name: 'HD 650',
    });
    expect(nameScope(product, { name: ['HD 650'] })).toBeNull();
    expect(identifiersDisagree(product, DT_80, DT_250)).toBe(true);
    expect(
      identifiersDisagree(product, DT_80, {
        ...DT_250,
        gtins: ['04010118471070', '04010118471063'],
      }),
    ).toBe(false);
    expect(identifiersDisagree(product, DT_80, { brand: ['beyerdynamic'] })).toBe(false);
  });

  it('label a claim on a name with the words that made it', () => {
    const claim = 'key0:sennheisergmbh|hd650';
    expect(claimLabel(product, { brand: ['Sennheiser GmbH'], name: ['HD-650'] }, claim)).toBe(
      'Sennheiser GmbH HD-650',
    );
    expect(claimLabel(product, { name: ['HD-650'] }, claim)).toBeNull();
    expect(claimLabel(product, { brand: ['Sennheiser'], name: ['HD 650'] }, 'gtins:1')).toBeNull();
    expect(claimLabel(product, { brand: ['Sennheiser'], name: ['HD 650'] }, 'key7:x')).toBeNull();
  });

  it('merge values once each', () => {
    const into: Values = { gtins: ['04010118471063'] };
    mergeValues(into, { gtins: ['04010118471063', '04010118471070'], name: ['DT 770 PRO'] });
    expect(into).toEqual({ gtins: ['04010118471063', '04010118471070'], name: ['DT 770 PRO'] });
  });
});
