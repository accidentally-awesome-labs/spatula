// apps/cli/tests/unit/components/explorer/entity-detail.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { EntityDetail } from '../../../../src/components/explorer/EntityDetail.js';
import type { EntityWithProvenance } from '@spatula/shared';

const mockEntity: EntityWithProvenance = {
  id: 'ent-1',
  jobId: 'job-1',
  mergedData: { name: 'Bose QC Ultra', price: '$429.00' },
  provenance: {
    name: {
      finalValue: 'Bose QC Ultra',
      provenanceType: 'merged',
      sources: [
        {
          sourceUrl: 'https://amazon.com',
          rawValue: 'Bose QuietComfort Ultra',
          normalizedValue: 'Bose QC Ultra',
        },
        {
          sourceUrl: 'https://bestbuy.com',
          rawValue: 'BOSE QC Ultra Headphones',
          normalizedValue: 'Bose QC Ultra',
        },
      ],
      hadConflict: false,
      resolution: 'most_complete',
    },
    price: {
      finalValue: '$429.00',
      provenanceType: 'normalized',
      sources: [
        { sourceUrl: 'https://amazon.com', rawValue: '$429.00', normalizedValue: '$429.00' },
      ],
      hadConflict: false,
    },
  },
  categories: ['headphones', 'audio'],
  qualityScore: 0.85,
  createdAt: '2026-03-10',
  sourceCount: 4,
  sources: [
    { extractionId: 'ext-1', matchConfidence: 0.9, sourceUrl: 'https://amazon.com' },
    { extractionId: 'ext-2', matchConfidence: 0.85, sourceUrl: 'https://bestbuy.com' },
  ],
};

describe('EntityDetail', () => {
  it('renders entity quality score', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('0.85');
  });

  it('renders entity categories', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('headphones');
    expect(lastFrame()).toContain('audio');
  });

  it('renders field names and values', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('name');
    expect(lastFrame()).toContain('Bose QC Ultra');
    expect(lastFrame()).toContain('price');
    expect(lastFrame()).toContain('$429.00');
  });

  it('renders provenance type for each field', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('merged');
    expect(lastFrame()).toContain('normalized');
  });

  it('renders source URLs', () => {
    const { lastFrame } = render(<EntityDetail entity={mockEntity} />);
    expect(lastFrame()).toContain('amazon.com');
  });
});
