import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { DiffPreview } from '../../../../src/components/review/DiffPreview.js';

describe('DiffPreview', () => {
  it('shows added fields for add_field action', () => {
    const action = {
      type: 'add_field',
      payload: { name: 'title', fieldType: 'string' },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;
    expect(frame).toContain('+');
    expect(frame).toContain('title');
    expect(frame).toContain('string');
  });

  it('shows merge info for merge_fields action', () => {
    const action = {
      type: 'merge_fields',
      payload: {
        aliases: ['cost', 'price_usd'],
        canonical: 'price',
      },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;
    expect(frame).toContain('cost');
    expect(frame).toContain('price_usd');
    expect(frame).toContain('price');
    expect(frame).toContain('merged');
  });

  it('shows removed field for remove_field action', () => {
    const action = {
      type: 'remove_field',
      payload: { name: 'deprecated_field', reason: 'no longer relevant' },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;
    expect(frame).toContain('-');
    expect(frame).toContain('deprecated_field');
    expect(frame).toContain('no longer relevant');
  });

  it('shows field changes for modify_field action', () => {
    const action = {
      type: 'modify_field',
      payload: {
        name: 'price',
        changes: { type: 'number', required: true },
      },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;
    expect(frame).toContain('~');
    expect(frame).toContain('price');
    expect(frame).toContain('type');
    expect(frame).toContain('number');
  });

  it('shows generic payload for unknown action types', () => {
    const action = {
      type: 'custom_action',
      payload: { foo: 'bar', count: 42 },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;
    expect(frame).toContain('foo');
    expect(frame).toContain('bar');
    expect(frame).toContain('count');
    expect(frame).toContain('42');
  });
});
