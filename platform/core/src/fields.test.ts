import { describe, expect, it } from 'vitest';
import { cleanText, normalizeValue, specLabelKey, type FieldDef } from './fields';

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
});

describe('specLabelKey', () => {
  it('compares labels without regard to case or spacing', () => {
    expect(specLabelKey(' Frequency  Response ')).toBe(specLabelKey('frequency response'));
  });
});
