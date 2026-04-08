// apps/cli/tests/unit/components/schema-conflict.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SchemaConflict } from '../../../src/components/SchemaConflict.js';
import type { SchemaDiff } from '../../../src/lib/schema-diff.js';

describe('SchemaConflict', () => {
  const mockDiff: SchemaDiff = {
    localOnly: [{ name: 'color', description: '', type: 'string', required: false }],
    remoteOnly: [{ name: 'rating', description: '', type: 'number', required: false }],
    changed: [{
      name: 'price',
      local: { name: 'price', description: '', type: 'string', required: false },
      remote: { name: 'price', description: '', type: 'currency', required: true },
      differences: ['type: string → currency', 'required: false → true'],
    }],
    unchanged: [{ name: 'title', description: '', type: 'string', required: true }],
    hasChanges: true,
  };

  it('renders the diff summary', () => {
    const onResolve = vi.fn();
    const { lastFrame } = render(
      <SchemaConflict diff={mockDiff} onResolve={onResolve} />,
    );
    const output = lastFrame();
    expect(output).toContain('Schema differences detected');
    expect(output).toContain('color');
    expect(output).toContain('rating');
    expect(output).toContain('price');
  });

  it('shows the three resolution options', () => {
    const onResolve = vi.fn();
    const { lastFrame } = render(
      <SchemaConflict diff={mockDiff} onResolve={onResolve} />,
    );
    const output = lastFrame();
    expect(output).toContain('Use remote');
    expect(output).toContain('Keep local');
    expect(output).toContain('Merge');
  });
});
