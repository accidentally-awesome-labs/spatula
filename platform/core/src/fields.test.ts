import { describe, expect, it } from 'vitest';
import { cleanText, normalizeValue, specLabelKey, type FieldDef } from './fields';
import { costRatio } from './testing/cost';

const field = (overrides: Partial<FieldDef>): FieldDef => ({
  type: 'text',
  required: false,
  list: false,
  identifier: false,
  llm: false,
  ...overrides,
});

describe('cleanText', () => {
  it('trims, joins whitespace, and reads numbers', () => {
    expect(cleanText('  HD\n 650 ')).toBe('HD 650');
    expect(cleanText(300)).toBe('300');
  });

  it('refuses empty text, control characters, and anything else', () => {
    expect(cleanText('   ')).toBeNull();
    expect(cleanText('HD\u0000650')).toBeNull();
    expect(cleanText({})).toBeNull();
  });
});

describe('normalizeValue', () => {
  it('keeps text within its length', () => {
    expect(normalizeValue(field({ maxLength: 10 }), ' LCD-X ')).toEqual({
      ok: true,
      value: 'LCD-X',
      key: 'LCD-X',
    });
    expect(normalizeValue(field({ maxLength: 3 }), 'LCD-X')).toEqual({
      ok: false,
      reason: 'longer than 3 characters',
    });
  });

  it('refuses text with an unpaired surrogate, and keeps a valid pair', () => {
    expect(normalizeValue(field({}), 'HD 650 \ud83c')).toMatchObject({ ok: false });
    expect(normalizeValue(field({}), 'A\udc00B')).toMatchObject({ ok: false });
    expect(normalizeValue(field({}), 'HD 650 \ud83c\udfa7')).toEqual({
      ok: true,
      value: 'HD 650 \ud83c\udfa7',
      key: 'HD 650 \ud83c\udfa7',
    });
  });

  it('matches enums without regard to case, and writes them as declared', () => {
    const category = field({ type: 'enum', values: ['Headphones', 'DAC/Amp'] });
    expect(normalizeValue(category, 'headphones')).toMatchObject({ ok: true, value: 'Headphones' });
    expect(normalizeValue(category, 'Speakers')).toEqual({
      ok: false,
      reason: 'not one of Headphones, DAC/Amp',
    });
  });

  it('reads GTINs from text or numbers', () => {
    const gtin = field({ type: 'gtin' });
    expect(normalizeValue(gtin, '819343015004')).toMatchObject({ value: '00819343015004' });
    expect(normalizeValue(gtin, 4006381333931)).toMatchObject({ value: '04006381333931' });
    expect(normalizeValue(gtin, '819343015005')).toMatchObject({ ok: false });
  });

  it('keeps https addresses without their fragment', () => {
    const url = field({ type: 'url' });
    expect(normalizeValue(url, 'https://www.audeze.com/products/lcd-x#reviews')).toMatchObject({
      value: 'https://www.audeze.com/products/lcd-x',
    });
    expect(normalizeValue(url, 'http://www.audeze.com/')).toEqual({
      ok: false,
      reason: 'not an https:// address',
    });
    expect(normalizeValue(url, `https://example.com/${'a'.repeat(500)}`)).toMatchObject({
      ok: false,
    });
  });

  it('refuses a web address with a NUL or an unpaired surrogate', () => {
    const url = field({ type: 'url' });
    expect(normalizeValue(url, 'https://a.example/x\u0000')).toEqual({
      ok: false,
      reason: 'not a web address',
    });
    expect(normalizeValue(url, 'https://a.example/\ud83c')).toEqual({
      ok: false,
      reason: 'not a web address',
    });
    expect(normalizeValue(url, 'https://a.example/x')).toMatchObject({
      ok: true,
      value: 'https://a.example/x',
    });
  });

  it('reads specs as a label and a value', () => {
    const specs = field({ type: 'specs', list: true });
    expect(normalizeValue(specs, { label: ' Impedance ', value: '300  Ω' })).toEqual({
      ok: true,
      value: { label: 'Impedance', value: '300 Ω' },
      key: 'impedance\u001f300 Ω',
    });
    expect(normalizeValue(specs, { label: 'Detachable cable', value: true })).toMatchObject({
      value: { label: 'Detachable cable', value: 'Yes' },
    });
    expect(normalizeValue(specs, { label: 'Impedance' })).toMatchObject({ ok: false });
    expect(normalizeValue(specs, { label: 'x'.repeat(61), value: '1' })).toMatchObject({
      ok: false,
    });
  });

  it('refuses a long run of combining marks before normalizing it', { timeout: 30_000 }, () => {
    // U+0301 sorts after U+0323, so every pair is out of order, and normalizing a run of them takes
    // time that grows with the square of its length. The run is 40,000 marks long.
    const specs = field({ type: 'specs', list: true });
    const refusals = (pairs: number) => {
      const marks = `a${'\u{301}\u{323}'.repeat(pairs)}`;
      return () => [
        normalizeValue(field({}), marks),
        normalizeValue(field({ type: 'enum', values: ['Headphones'] }), marks),
        normalizeValue(specs, { label: marks, value: '1' }),
        normalizeValue(specs, { label: 'Weight', value: marks }),
      ];
    };
    const longest = refusals(20_000);
    const longSpec = 'a spec with a label over 60 or a value over 200 characters';
    expect(longest()).toEqual([
      { ok: false, reason: 'longer than 500 characters' },
      { ok: false, reason: 'not one of Headphones' },
      { ok: false, reason: longSpec },
      { ok: false, reason: longSpec },
    ]);
    // Normalizing first made each mark cost about 16 times as much in this run as in one a
    // sixteenth as long, itself over four times longer than any field allows. Refusing first costs
    // about the same at any length.
    expect(costRatio(refusals(1_250), longest, 16)).toBeLessThan(4);
  });

  it('collapses whitespace before deciding a value is too long to normalize', () => {
    expect(normalizeValue(field({ maxLength: 3 }), `a${' '.repeat(100)}b`)).toEqual({
      ok: true,
      value: 'a b',
      key: 'a b',
    });
  });

  it('keeps text that normalizing shrinks fourfold to within its cap', () => {
    // Alpha with psili, varia, and ypogegrammeni is four code points decomposed, and one composed.
    const decomposed = '\u{3b1}\u{313}\u{300}\u{345}'.repeat(10);
    expect(normalizeValue(field({ maxLength: 10 }), decomposed)).toEqual({
      ok: true,
      value: '\u{1f82}'.repeat(10),
      key: '\u{1f82}'.repeat(10),
    });
    expect(normalizeValue(field({ maxLength: 10 }), `${decomposed}\u{3b1}`)).toEqual({
      ok: false,
      reason: 'longer than 10 characters',
    });
  });
});

describe('specLabelKey', () => {
  it('compares labels without regard to case or spacing', () => {
    expect(specLabelKey(' Frequency  Response ')).toBe(specLabelKey('frequency response'));
  });
});
