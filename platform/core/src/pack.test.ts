import { describe, expect, it } from 'vitest';
import { parseDefinition } from './definition';
import { packIssues, type RecordTypePack } from './pack';

const pack: RecordTypePack = { fields: { gtins: { type: 'gtin', list: true } }, extract: () => [] };

function definitionWith(gtins: Record<string, unknown>, packName = 'test/product') {
  const result = parseDefinition({
    dataset: 'd',
    recordTypes: {
      product: {
        pack: packName,
        identity: { keys: [['name']] },
        fields: { name: { type: 'text', required: true }, gtins },
      },
    },
    sources: [
      {
        id: 's',
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
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.definition;
}

describe('packIssues', () => {
  it('accepts fields typed as the pack fills them', () => {
    expect(
      packIssues(definitionWith({ type: 'gtin', list: true }), { 'test/product': pack }),
    ).toEqual([]);
  });

  it('names fields the pack would fill differently, and packs that do not exist', () => {
    expect(packIssues(definitionWith({ type: 'text' }), { 'test/product': pack })).toEqual([
      'recordTypes.product.fields.gtins: The test/product pack fills gtins as a list of gtin.',
    ]);
    expect(
      packIssues(definitionWith({ type: 'gtin', list: true }, 'other/product'), {
        'test/product': pack,
      }),
    ).toEqual(['recordTypes.product.pack: There’s no pack called other/product.']);
  });

  it('names a field that differs from the pack in only its type, or only in being a list', () => {
    const asAList =
      'recordTypes.product.fields.gtins: The test/product pack fills gtins as a list of gtin.';
    expect(
      packIssues(definitionWith({ type: 'text', list: true }), { 'test/product': pack }),
    ).toEqual([asAList]);
    expect(packIssues(definitionWith({ type: 'gtin' }), { 'test/product': pack })).toEqual([
      asAList,
    ]);
    const single: RecordTypePack = {
      fields: { gtins: { type: 'gtin', list: false } },
      extract: () => [],
    };
    expect(
      packIssues(definitionWith({ type: 'gtin', list: true }), { 'test/product': single }),
    ).toEqual(['recordTypes.product.fields.gtins: The test/product pack fills gtins as gtin.']);
  });
});
