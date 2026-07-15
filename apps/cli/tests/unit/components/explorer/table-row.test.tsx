import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { TableRow } from '../../../../src/components/explorer/TableRow.js';
import type { Entity } from '@accidentally-awesome-labs/spatula-shared';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'ent-1',
    jobId: 'job-1',
    mergedData: { name: 'Widget', price: '9.99' },
    categories: ['product'],
    qualityScore: 0.85,
    createdAt: '2026-01-01T00:00:00Z',
    sourceCount: 3,
    ...overrides,
  };
}

describe('TableRow', () => {
  it('renders a row with field values', () => {
    const entity = makeEntity();
    const { lastFrame } = render(
      <TableRow
        entity={entity}
        rowNumber={1}
        selected={false}
        schemaFields={['name', 'price']}
        columnOffset={0}
        maxVisibleColumns={2}
        columnWidth={15}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Widget');
    expect(frame).toContain('9.99');
    expect(frame).toContain('0.85');
    expect(frame).toContain('3');
  });

  it('renders selected state with ">" prefix', () => {
    const entity = makeEntity();
    const { lastFrame: selectedFrame } = render(
      <TableRow
        entity={entity}
        rowNumber={1}
        selected={true}
        schemaFields={['name']}
        columnOffset={0}
        maxVisibleColumns={1}
        columnWidth={15}
      />,
    );
    const { lastFrame: unselectedFrame } = render(
      <TableRow
        entity={entity}
        rowNumber={1}
        selected={false}
        schemaFields={['name']}
        columnOffset={0}
        maxVisibleColumns={1}
        columnWidth={15}
      />,
    );
    expect(selectedFrame()!).toContain('>');
    // Unselected row should not start with >
    expect(unselectedFrame()!).not.toMatch(/>/);
  });

  it('truncates long values to fit column width', () => {
    const entity = makeEntity({
      mergedData: { name: 'A very long product name that exceeds column width' },
    });
    const columnWidth = 10;
    const { lastFrame } = render(
      <TableRow
        entity={entity}
        rowNumber={1}
        selected={false}
        schemaFields={['name']}
        columnOffset={0}
        maxVisibleColumns={1}
        columnWidth={columnWidth}
      />,
    );
    const frame = lastFrame()!;
    // The truncated value should end with ellipsis and not contain the full string
    expect(frame).toContain('\u2026');
    expect(frame).not.toContain('A very long product name that exceeds column width');
  });

  it('handles missing/undefined field values gracefully', () => {
    const entity = makeEntity({
      mergedData: {},
    });
    const { lastFrame } = render(
      <TableRow
        entity={entity}
        rowNumber={1}
        selected={false}
        schemaFields={['name', 'price']}
        columnOffset={0}
        maxVisibleColumns={2}
        columnWidth={15}
      />,
    );
    const frame = lastFrame()!;
    // Should render without crashing; missing fields show as empty strings
    expect(frame).toBeTruthy();
    // Row number and quality score should still be present
    expect(frame).toContain('0.85');
  });
});
