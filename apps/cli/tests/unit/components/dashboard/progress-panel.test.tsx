import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ProgressPanel } from '../../../../src/components/dashboard/ProgressPanel.js';

describe('ProgressPanel', () => {
  const sampleJob = {
    status: 'running',
    stats: {
      pagesFound: 100,
      pagesCrawled: 75,
      pagesExtracted: 50,
      pagesReconciled: 25,
      actionsPending: 10,
      actionsApplied: 5,
    },
  };

  it('renders progress bars for all stages', () => {
    const { lastFrame } = render(<ProgressPanel job={sampleJob} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Crawled');
    expect(frame).toContain('75/100');
    expect(frame).toContain('Extracted');
    expect(frame).toContain('50/100');
    expect(frame).toContain('Reconciled');
    expect(frame).toContain('25/100');
  });

  it('shows percentage for each progress bar', () => {
    const { lastFrame } = render(<ProgressPanel job={sampleJob} />);
    const frame = lastFrame()!;
    expect(frame).toContain('75%');
    expect(frame).toContain('50%');
    expect(frame).toContain('25%');
  });

  it('shows action summary with pending and applied counts', () => {
    const { lastFrame } = render(<ProgressPanel job={sampleJob} />);
    const frame = lastFrame()!;
    expect(frame).toContain('10 pending');
    expect(frame).toContain('5 applied');
  });

  it('handles zero total pages gracefully', () => {
    const emptyJob = {
      status: 'running',
      stats: {
        pagesFound: 0,
        pagesCrawled: 0,
        pagesExtracted: 0,
        pagesReconciled: 0,
        actionsPending: 0,
        actionsApplied: 0,
      },
    };
    const { lastFrame } = render(<ProgressPanel job={emptyJob} />);
    const frame = lastFrame()!;
    expect(frame).toContain('0/0');
    expect(frame).toContain('0%');
  });

  it('shows job status', () => {
    const { lastFrame } = render(<ProgressPanel job={sampleJob} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Status:');
    expect(frame).toContain('running');
  });
});
