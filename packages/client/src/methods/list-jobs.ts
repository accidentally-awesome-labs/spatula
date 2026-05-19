import type { SpatulaClient } from '../client.js';

export interface ListJobsParams {
  cursor?: string;
  limit?: number;
  status?: string;
}

export interface JobListItem {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface ListJobsResult {
  data: JobListItem[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * List jobs (cursor-paginated). GET /api/v1/jobs.
 */
export async function listJobs(
  client: SpatulaClient,
  params: ListJobsParams = {},
): Promise<ListJobsResult> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  const qs = query.toString();
  return client.request<ListJobsResult>('GET', `/api/v1/jobs${qs ? `?${qs}` : ''}`);
}
