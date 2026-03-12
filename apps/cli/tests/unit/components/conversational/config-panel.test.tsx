import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ConfigPanel } from '../../../../src/components/conversational/ConfigPanel.js';
import type { JobConfig } from '@spatula/core';

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    name: '',
    description: '',
    seedUrls: [],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    ...overrides,
  };
}

describe('ConfigPanel', () => {
  it('renders empty config placeholder', () => {
    const config = makeConfig();
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Config');
    expect(frame).toContain('Name: (not set)');
    expect(frame).toContain('Incomplete');
  });

  it('shows job name when set', () => {
    const config = makeConfig({ name: 'My Scraping Job' });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Name: My Scraping Job');
  });

  it('shows description when set', () => {
    const config = makeConfig({ description: 'Scrape product data' });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Scrape product data');
  });

  it('does not show description section when empty', () => {
    const config = makeConfig({ description: '' });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    // "Desc:" label should not appear
    expect(frame).not.toContain('Desc:');
  });

  it('shows seed URLs when set', () => {
    const config = makeConfig({
      seedUrls: ['https://example.com', 'https://other.com'],
    });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('URLs: 2');
    expect(frame).toContain('https://example.com');
    expect(frame).toContain('https://other.com');
  });

  it('shows schema mode', () => {
    const config = makeConfig({ schema: { mode: 'fixed' } });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('fixed');
  });

  it('shows user fields when set', () => {
    const config = makeConfig({
      schema: {
        mode: 'hybrid',
        userFields: [
          { name: 'price', description: 'Product price', type: 'currency', required: true },
          { name: 'title', description: 'Product title', type: 'string', required: false },
        ],
      },
    });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('price');
    expect(frame).toContain('currency');
    expect(frame).toContain('*'); // required indicator
    expect(frame).toContain('title');
    expect(frame).toContain('string');
  });

  it('shows crawl settings', () => {
    const config = makeConfig({
      crawl: { maxDepth: 3, maxPages: 500, concurrency: 10, crawlerType: 'firecrawl' },
    });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('3');
    expect(frame).toContain('500');
    expect(frame).toContain('10');
    expect(frame).toContain('firecrawl');
  });

  it('shows primary model name', () => {
    const config = makeConfig({
      llm: { primaryModel: 'openai/gpt-4o' },
    });
    const { lastFrame } = render(<ConfigPanel config={config} />);
    const frame = lastFrame()!;
    expect(frame).toContain('openai/gpt-4o');
  });

  it('shows validation status "Ready to start" when isValid=true', () => {
    const config = makeConfig({ name: 'Job', seedUrls: ['https://example.com'] });
    const { lastFrame } = render(<ConfigPanel config={config} isValid={true} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Ready to start');
  });

  it('shows validation status "Incomplete" when isValid=false', () => {
    const config = makeConfig();
    const { lastFrame } = render(<ConfigPanel config={config} isValid={false} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Incomplete');
  });
});
