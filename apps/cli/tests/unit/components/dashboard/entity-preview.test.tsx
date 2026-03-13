import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { EntityPreview } from '../../../../src/components/dashboard/EntityPreview.js';

describe('EntityPreview', () => {
  it('renders entity names', () => {
    const entities = [
      { mergedData: { name: 'Acme Corp', phone: '555-1234' }, categories: [] },
      { mergedData: { name: 'Globex Inc', email: 'info@globex.com' }, categories: [] },
    ];
    const { lastFrame } = render(<EntityPreview entities={entities} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Acme Corp');
    expect(frame).toContain('Globex Inc');
  });

  it('shows categories for entities', () => {
    const entities = [
      { mergedData: { name: 'Acme Corp' }, categories: ['tech', 'startup'] },
    ];
    const { lastFrame } = render(<EntityPreview entities={entities} />);
    const frame = lastFrame()!;
    expect(frame).toContain('[tech, startup]');
  });

  it('shows entity count with totalCount prop', () => {
    const entities = [
      { mergedData: { name: 'Acme Corp' }, categories: [] },
      { mergedData: { name: 'Globex Inc' }, categories: [] },
    ];
    const { lastFrame } = render(<EntityPreview entities={entities} totalCount={50} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Entities (2 of 50)');
  });

  it('shows empty message when no entities', () => {
    const { lastFrame } = render(<EntityPreview entities={[]} />);
    const frame = lastFrame()!;
    expect(frame).toContain('No entities yet');
  });
});
