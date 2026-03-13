import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SchemaPanel } from '../../../../src/components/dashboard/SchemaPanel.js';

describe('SchemaPanel', () => {
  it('renders schema mode and field count', () => {
    const schema = {
      mode: 'hybrid',
      version: 3,
      definition: {
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'price', type: 'number', required: true },
          { name: 'url', type: 'string', required: false },
        ],
        categories: [],
      },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;
    expect(frame).toContain('hybrid');
    expect(frame).toContain('3 fields');
    expect(frame).toContain('v3');
  });

  it('lists field names and types', () => {
    const schema = {
      mode: 'strict',
      version: 1,
      definition: {
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'price', type: 'number', required: false },
        ],
        categories: [],
      },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;
    expect(frame).toContain('title');
    expect(frame).toContain('(string)');
    expect(frame).toContain('price');
    expect(frame).toContain('(number)');
  });

  it('shows categories when present', () => {
    const schema = {
      mode: 'flexible',
      version: 2,
      definition: {
        fields: [],
        categories: ['Electronics', 'Books', 'Clothing'],
      },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Categories:');
    expect(frame).toContain('Electronics');
    expect(frame).toContain('Books');
    expect(frame).toContain('Clothing');
  });

  it('handles null schema gracefully', () => {
    const { lastFrame } = render(<SchemaPanel schema={null} />);
    const frame = lastFrame()!;
    expect(frame).toContain('No schema data yet');
    expect(frame).toContain('Schema');
  });

  it('handles schema with no fields', () => {
    const schema = {
      mode: 'auto',
      version: 1,
      definition: {
        fields: [],
        categories: [],
      },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;
    expect(frame).toContain('0 fields');
  });
});
