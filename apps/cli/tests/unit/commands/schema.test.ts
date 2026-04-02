import { describe, it, expect } from 'vitest';
import { formatSchemaTable, formatVersionHistory } from '../../../src/commands/schema.js';

// ---------------------------------------------------------------------------
// formatSchemaTable
// ---------------------------------------------------------------------------

describe('formatSchemaTable', () => {
  it('renders a field table for a valid schema', () => {
    const schema = {
      id: 'schema-1',
      version: 3,
      definition: {
        version: 3,
        fields: [
          { name: 'title', type: 'string', required: true, description: 'Page title' },
          { name: 'price', type: 'currency', required: false, description: 'Product price' },
          { name: 'url', type: 'url', required: true, description: 'Canonical URL' },
        ],
        fieldAliases: [],
        createdAt: '2026-03-30T00:00:00Z',
        parentVersion: 2,
      },
    };

    const output = formatSchemaTable(schema);

    // Header line
    expect(output).toContain('Schema v3');
    expect(output).toContain('3 fields');

    // Column headers
    expect(output).toContain('Name');
    expect(output).toContain('Type');
    expect(output).toContain('Required');
    expect(output).toContain('Description');

    // Field rows
    expect(output).toContain('title');
    expect(output).toContain('string');
    expect(output).toContain('yes');
    expect(output).toContain('Page title');

    expect(output).toContain('price');
    expect(output).toContain('currency');
    expect(output).toContain('no');
    expect(output).toContain('Product price');

    expect(output).toContain('url');
    expect(output).toContain('Canonical URL');
  });

  it('returns a no-schema message when schema is null', () => {
    const output = formatSchemaTable(null);
    expect(output).toBe('No schema found. Run `spatula run` to discover a schema.');
  });

  it('handles a schema with zero fields', () => {
    const schema = {
      id: 'schema-empty',
      version: 1,
      definition: {
        version: 1,
        fields: [],
        fieldAliases: [],
        createdAt: '2026-03-30T00:00:00Z',
        parentVersion: null,
      },
    };

    const output = formatSchemaTable(schema);
    expect(output).toContain('Schema v1');
    expect(output).toContain('0 fields');
    // Should still have column headers
    expect(output).toContain('Name');
    expect(output).toContain('Type');
  });
});

// ---------------------------------------------------------------------------
// formatVersionHistory
// ---------------------------------------------------------------------------

describe('formatVersionHistory', () => {
  it('renders version history table', () => {
    const versions = [
      {
        id: 'v3-id',
        version: 3,
        definition: {
          version: 3,
          fields: [
            { name: 'title', type: 'string', required: true, description: 'Title' },
            { name: 'price', type: 'currency', required: false, description: 'Price' },
            { name: 'url', type: 'url', required: true, description: 'URL' },
          ],
          fieldAliases: [],
          createdAt: '2026-03-30T02:00:00Z',
          parentVersion: 2,
        },
        parentId: 'v2-id',
        createdAt: '2026-03-30T02:00:00Z',
      },
      {
        id: 'v2-id',
        version: 2,
        definition: {
          version: 2,
          fields: [
            { name: 'title', type: 'string', required: true, description: 'Title' },
            { name: 'price', type: 'currency', required: false, description: 'Price' },
          ],
          fieldAliases: [],
          createdAt: '2026-03-30T01:00:00Z',
          parentVersion: 1,
        },
        parentId: 'v1-id',
        createdAt: '2026-03-30T01:00:00Z',
      },
      {
        id: 'v1-id',
        version: 1,
        definition: {
          version: 1,
          fields: [
            { name: 'title', type: 'string', required: true, description: 'Title' },
          ],
          fieldAliases: [],
          createdAt: '2026-03-30T00:00:00Z',
          parentVersion: null,
        },
        parentId: null,
        createdAt: '2026-03-30T00:00:00Z',
      },
    ];

    const output = formatVersionHistory(versions);

    // Title
    expect(output).toContain('Schema History');
    expect(output).toContain('3 versions');

    // Column headers
    expect(output).toContain('Version');
    expect(output).toContain('Fields');
    expect(output).toContain('Changes');
    expect(output).toContain('Created At');

    // Version rows
    expect(output).toContain('v3');
    expect(output).toContain('v2');
    expect(output).toContain('v1');

    // Diff summaries — v3 added 1 field vs v2, v2 added 1 field vs v1, v1 is initial
    expect(output).toContain('+1 field');
    expect(output).toContain('(initial)');
  });

  it('returns a no-versions message when array is empty', () => {
    const output = formatVersionHistory([]);
    expect(output).toBe('No schema versions found. Run `spatula run` to discover a schema.');
  });

  it('uses singular "version" for a single entry', () => {
    const versions = [
      {
        id: 'v1-id',
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', type: 'string', required: true, description: 'Title' }],
          fieldAliases: [],
          createdAt: '2026-03-30T00:00:00Z',
          parentVersion: null,
        },
        parentId: null,
        createdAt: '2026-03-30T00:00:00Z',
      },
    ];

    const output = formatVersionHistory(versions);
    expect(output).toContain('1 version)');
    expect(output).not.toContain('1 versions');
  });
});
