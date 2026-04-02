// apps/cli/tests/unit/components/explorer/export-dialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { createCliStore } from '../../../../src/store/index.js';
import type { CliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';

vi.mock('../../../../src/hooks/useKeyboard.js', () => ({
  useKeyboard: vi.fn(),
}));

vi.mock('../../../../src/hooks/useExport.js', () => ({
  useExport: vi.fn().mockReturnValue({
    isExporting: false,
    exportProgress: null,
    exportSingleEntity: vi.fn().mockResolvedValue('/path/to/file.json'),
    exportEntitySet: vi.fn().mockResolvedValue('/path/to/file.json'),
  }),
}));

describe('ExportDialog', () => {
  it('renders export format options', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = {} as SpatulaApiClient;

    const { ExportDialog } = await import('../../../../src/components/explorer/ExportDialog.js');
    const { lastFrame } = render(
      <ExportDialog store={store} backend={apiClient} fromDetail={false} onClose={vi.fn()} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('JSON');
    expect(frame).toContain('CSV');
  });

  it('renders scope options with entity count', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setTotalEntityCount(47);
    const apiClient = {} as SpatulaApiClient;

    const { ExportDialog } = await import('../../../../src/components/explorer/ExportDialog.js');
    const { lastFrame } = render(
      <ExportDialog store={store} backend={apiClient} fromDetail={false} onClose={vi.fn()} />,
    );
    expect(lastFrame()).toContain('47');
  });

  it('shows Current entity option when fromDetail is true', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setExpandedEntity({ id: 'e1', mergedData: {}, provenance: {}, sources: [], categories: [], qualityScore: 0.9, createdAt: '', sourceCount: 1, jobId: 'j1' } as any);
    const apiClient = {} as SpatulaApiClient;

    const { ExportDialog } = await import('../../../../src/components/explorer/ExportDialog.js');
    const { lastFrame } = render(
      <ExportDialog store={store} backend={apiClient} fromDetail={true} onClose={vi.fn()} />,
    );
    expect(lastFrame()).toContain('Current entity');
  });
});
