import type { SpatulaClient } from '../client.js';

export interface GetEntitiesParams {
  cursor?: string;
  limit?: number;
}

export interface EntityListItem {
  id: string;
  jobId: string;
  tenantId: string;
  mergedData: Record<string, unknown>;
  categories: string[];
  qualityScore: number;
  sourceCount: number;
  createdAt: string;
}

export interface GetEntitiesResult {
  data: EntityListItem[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * List entities for a job (cursor-paginated). GET /api/v1/jobs/:jobId/entities.
 */
export async function getEntities(
  client: SpatulaClient,
  jobId: string,
  params: GetEntitiesParams = {},
): Promise<GetEntitiesResult> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return client.request<GetEntitiesResult>(
    'GET',
    `/api/v1/jobs/${encodeURIComponent(jobId)}/entities${qs ? `?${qs}` : ''}`,
  );
}
