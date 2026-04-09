// apps/cli/tests/unit/components/schema-conflict.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SchemaConflict } from '../../../src/components/SchemaConflict.js';
import type { SchemaDiff } from '../../../src/lib/schema-diff.js';

/** Wait for React effects (useEffect in useInput) to settle. */
const waitForEffects = () => new Promise(resolve => setTimeout(resolve, 50));

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

  it('number key 1 invokes onResolve with remote', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<SchemaConflict diff={mockDiff} onResolve={onResolve} />);
    await waitForEffects();
    stdin.write('1');
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith('remote');
  });

  it('number key 2 invokes onResolve with local', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<SchemaConflict diff={mockDiff} onResolve={onResolve} />);
    await waitForEffects();
    stdin.write('2');
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith('local');
  });

  it('number key 3 invokes onResolve with merge', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<SchemaConflict diff={mockDiff} onResolve={onResolve} />);
    await waitForEffects();
    stdin.write('3');
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith('merge');
  });
});
