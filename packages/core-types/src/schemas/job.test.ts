import { describe, expect, it } from 'vitest';
import { JobConfig } from './job.js';

describe('JobConfig', () => {
  it('preserves webhook configuration through parsing', () => {
    const parsed = JobConfig.parse({
      tenantId: '11111111-1111-4111-8111-111111111111',
      name: 'webhook job',
      description: 'Extract data and notify subscribers.',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 0, maxPages: 1, concurrency: 1, crawlerType: 'firecrawl' },
      schema: {
        mode: 'fixed',
        userFields: [{ name: 'title', description: 'Title', type: 'string', required: true }],
      },
      llm: { primaryModel: 'deepseek/deepseek-v4-flash' },
      webhooks: {
        url: 'https://hooks.example.com/spatula',
        secret: 'secret-with-enough-length',
        events: ['job.completed', 'export.completed'],
      },
    });

    expect(parsed.webhooks).toEqual({
      url: 'https://hooks.example.com/spatula',
      secret: 'secret-with-enough-length',
      events: ['job.completed', 'export.completed'],
    });
  });
});
