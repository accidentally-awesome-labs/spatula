// apps/cli/tests/unit/lib/yaml-fields.test.ts
import { describe, it, expect } from 'vitest';
import { appendFieldsToYaml } from '../../../src/lib/yaml-fields.js';

describe('appendFieldsToYaml', () => {
  it('appends fields after existing fields block', () => {
    const yaml = `name: My Crawl
seeds:
  - https://example.com
fields:
  - title: string
  - price: currency
depth: 2
`;
    const newFields = [
      { name: 'rating', type: 'number' },
      { name: 'brand', type: 'string', required: true },
    ];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('# Discovered by remote crawl (2026-04-08):');
    expect(result).toContain('  - rating: number');
    expect(result).toContain('  - brand: string');
    // Existing content preserved
    expect(result).toContain('  - title: string');
    expect(result).toContain('depth: 2');
  });

  it('creates fields block if none exists', () => {
    const yaml = `name: My Crawl
seeds:
  - https://example.com
depth: 2
`;
    const newFields = [{ name: 'title', type: 'string' }];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('fields:');
    expect(result).toContain('  - title: string');
  });

  it('handles extended field format for required fields', () => {
    const yaml = `name: Test
fields:
  - title: string
`;
    const newFields = [{ name: 'price', type: 'currency', required: true }];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('  - field: price');
    expect(result).toContain('    type: currency');
    expect(result).toContain('    required: true');
  });

  it('handles empty fields array as no-op', () => {
    const yaml = `name: Test\nfields:\n  - title: string\n`;
    const result = appendFieldsToYaml(yaml, [], '2026-04-08');
    expect(result).toBe(yaml);
  });

  it('handles empty array fields syntax', () => {
    const yaml = `name: Test\nfields: []\ndepth: 2\n`;
    const newFields = [{ name: 'title', type: 'string' }];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('fields:');
    expect(result).toContain('  - title: string');
    expect(result).not.toContain('[]');
  });
});
