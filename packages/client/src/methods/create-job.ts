import type { SpatulaClient } from '../client.js';

export interface CreateJobInput {
  name: string;
  description?: string;
  seedUrls: string[];
  // Schema/crawl/llm config — full validation server-side. Plan 16-5 will
  // tighten the input type using `@spatula/core-types` JobConfigSchema.
  [k: string]: unknown;
}

export interface CreateJobResult {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  createdAt: string;
}

/**
 * Create a new job. POST /api/v1/jobs.
 */
export async function createJob(
  client: SpatulaClient,
  input: CreateJobInput,
): Promise<CreateJobResult> {
  return client.request<CreateJobResult>('POST', '/api/v1/jobs', input);
}
