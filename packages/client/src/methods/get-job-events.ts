import type { SpatulaClient } from '../client.js';

export interface JobEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Fetch the latest job events (non-streaming). GET /api/v1/jobs/:jobId/events.
 *
 * Streaming SSE flavor lands in Phase 17 (SDK + SSE + browser OIDC); this
 * helper is the non-streaming fallback used during plan 16-2's basic
 * scaffolding.
 */
export async function getJobEvents(
  client: SpatulaClient,
  jobId: string,
  params: { lastEventId?: string } = {},
): Promise<JobEvent[]> {
  const query = new URLSearchParams();
  if (params.lastEventId) query.set('lastEventId', params.lastEventId);
  const qs = query.toString();
  return client.request<JobEvent[]>(
    'GET',
    `/api/v1/jobs/${encodeURIComponent(jobId)}/events${qs ? `?${qs}` : ''}`,
  );
}
