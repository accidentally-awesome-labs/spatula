import { describe, expect, it } from 'vitest';
import { inferFields } from '../../../src/commands/onboarding.js';

describe('guided onboarding helpers', () => {
  it('turns plain field requests into safe schema fields', () => {
    expect(inferFields('product title, price, image URL, in stock')).toEqual([
      { name: 'title', type: 'string', required: true },
      { name: 'price', type: 'currency', required: false },
      { name: 'image_url', type: 'url', required: false },
      { name: 'in_stock', type: 'boolean', required: false },
    ]);
  });

  it('uses a useful fallback when the request is empty', () => {
    expect(inferFields('')).toEqual([
      { name: 'title', type: 'string', required: true },
      { name: 'description', type: 'string' },
    ]);
  });
});
