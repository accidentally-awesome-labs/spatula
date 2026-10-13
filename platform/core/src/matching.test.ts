import { describe, expect, it } from 'vitest';
import { parseDefinition, type RecordType } from './definition';
import type { FieldValue } from './fields';
import { identityClaims } from './identity';
import {
  identifiersDisagree,
  mergeValues,
  nameKey,
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

const plan = (
  values: Values,
  others: Record<string, Values> = {},
  verdicts: Record<string, MatchVerdict> = {},
  waitingOn: string[] = [],
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
    waitingOn: new Set(waitingOn),
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

  describe('while another page of the same name waits for an answer about the entity', () => {
    const named = { brand: ['beyerdynamic'], name: ['DT 770 PRO'] };

    it('waits, rather than join the entity on a name the answer may split', () => {
      expect(plan(named, { sp_e1: DT_80 }, {}, ['sp_e1'])).toEqual({ kind: 'wait' });
      // A wait on another entity holds nothing back.
      expect(plan(named, { sp_e1: DT_80 }, {}, ['sp_e9'])).toEqual({
        kind: 'join',
        entityId: 'sp_e1',
      });
    });

    it('still joins on an identifier, or on a verdict', () => {
      expect(plan(DT_80, { sp_e1: DT_80 }, {}, ['sp_e1'])).toEqual({
        kind: 'join',
        entityId: 'sp_e1',
      });
      expect(plan(named, { sp_e1: DT_80 }, { sp_e1: 'same' }, ['sp_e1'])).toEqual({
        kind: 'join',
        entityId: 'sp_e1',
      });
    });

    it('asks its own question when its identifiers disagree with the entity’s', () => {
      expect(plan(DT_250, { sp_e1: DT_80 }, {}, ['sp_e1'])).toEqual({
        kind: 'ask',
        entityIds: ['sp_e1'],
      });
    });
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

  it('key a name within its scope, so that records named alike share a key', () => {
    const key = nameKey(product, { brand: ['Sennheiser GmbH'], name: ['HD-650'] });
    expect(key).not.toBeNull();
    expect(nameKey(product, { brand: ['sennheiser gmbh'], name: ['hd 650'] })).toBe(key);
    expect(nameKey(product, { brand: ['Sennheiser GmbH'], name: ['HD 650S'] })).not.toBe(key);
    expect(nameKey(product, { brand: ['Focal'], name: ['HD 650'] })).not.toBe(key);
    expect(nameKey(product, { name: ['HD 650'] })).toBeNull();
  });

  it('merge values once each', () => {
    const into: Values = { gtins: ['04010118471063'] };
    mergeValues(into, { gtins: ['04010118471063', '04010118471070'], name: ['DT 770 PRO'] });
    expect(into).toEqual({ gtins: ['04010118471063', '04010118471070'], name: ['DT 770 PRO'] });
  });
});
