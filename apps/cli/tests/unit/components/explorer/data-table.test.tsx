// apps/cli/tests/unit/components/explorer/data-table.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

vi.mock('../../../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

describe('DataTable', () => {
  it('module exports DataTable component', async () => {
    const mod = await import('../../../../src/components/explorer/DataTable.js');
    expect(mod.DataTable).toBeDefined();
  });

  it('renders empty state when no entities', async () => {
    const { DataTable } = await import('../../../../src/components/explorer/DataTable.js');
    const { lastFrame } = render(
      <DataTable
        entities={[]}
        schemaFields={['name', 'price']}
        selectedIndex={0}
        currentPage={0}
        totalPages={1}
        totalCount={0}
        columnOffset={0}
        pageSize={20}
      />,
    );
    expect(lastFrame()).toContain('No entities found');
  });

  it('renders entity rows with schema columns', async () => {
    const { DataTable } = await import('../../../../src/components/explorer/DataTable.js');
    const entities = [
      {
        id: 'e1',
        mergedData: { name: 'Product A', price: '$10' },
        qualityScore: 0.95,
        sourceCount: 3,
        categories: [],
        jobId: 'j1',
        createdAt: '',
      },
      {
        id: 'e2',
        mergedData: { name: 'Product B', price: '$20' },
        qualityScore: 0.8,
        sourceCount: 1,
        categories: [],
        jobId: 'j1',
        createdAt: '',
      },
    ];
    const { lastFrame } = render(
      <DataTable
        entities={entities as any}
        schemaFields={['name', 'price']}
        selectedIndex={0}
        currentPage={0}
        totalPages={1}
        totalCount={2}
        columnOffset={0}
        pageSize={20}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Product A');
    expect(frame).toContain('Product B');
    expect(frame).toContain('0.95');
    expect(frame).toContain('Page 1 of 1');
  });
});
