import { describe, expect, it } from 'vitest';
import { formatEmptyResultDiagnostics, inferFields } from '../../../src/commands/onboarding.js';

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

  it('explains persisted HTTP failures instead of pointing at empty error logs', () => {
    const lines = formatEmptyResultDiagnostics({
      schemaFields: 2,
      taskStats: { pending: 0, inProgress: 0, completed: 0, failed: 1, skipped: 0 },
      failures: [
        {
          url: 'https://example.com/missing',
          errorMessage: 'HTTP 404 while crawling https://example.com/missing',
          attempts: 1,
        },
      ],
    });

    expect(lines.join('\n')).toContain('HTTP 404');
    expect(lines.join('\n')).toContain('https://example.com/missing');
    expect(lines.join('\n')).toContain('Fix the failed seed URL');
  });

  it('identifies a missing local schema as the reason extraction could not start', () => {
    const lines = formatEmptyResultDiagnostics({
      schemaFields: null,
      taskStats: { pending: 0, inProgress: 0, completed: 1, failed: 0, skipped: 0 },
      failures: [],
    });

    expect(lines.join('\n')).toContain('No extraction schema');
    expect(lines.join('\n')).toContain('spatula run');
  });
});
