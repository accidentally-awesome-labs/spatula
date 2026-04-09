/**
 * HTTP client for the Spatula API server.
 *
 * Wraps all REST endpoints behind typed methods, handles header injection,
 * query-string building, response unwrapping, and error normalization.
 */

// ---------------------------------------------------------------------------
// ApiError
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SpatulaApiClientOptions {
  /** Optional API key for authenticated requests. */
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SpatulaApiClient {
  public readonly baseUrl: string;
  public readonly tenantId: string;
  private readonly apiKey?: string;

  constructor(baseUrl: string, tenantId: string, options?: SpatulaApiClientOptions) {
    // Strip trailing slash so callers don't need to worry about it
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tenantId = tenantId;
    this.apiKey = options?.apiKey;
  }

  // -----------------------------------------------------------------------
  // Jobs
  // -----------------------------------------------------------------------

  async createJob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post('/api/v1/jobs', body);
  }

  async listJobs(query?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return this.get('/api/v1/jobs', query);
  }

  async getJob(id: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${id}`);
  }

  async startJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/start`);
  }

  async pauseJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/pause`);
  }

  async resumeJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/resume`);
  }

  async cancelJob(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/cancel`);
  }

  async triggerReconciliation(id: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${id}/reconcile`);
  }

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  async getSchema(jobId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/schema`);
  }

  async listSchemaVersions(jobId: string): Promise<Record<string, unknown>[]> {
    return this.get(`/api/v1/jobs/${jobId}/schema/versions`);
  }

  // -----------------------------------------------------------------------
  // Extractions
  // -----------------------------------------------------------------------

  async listExtractions(
    jobId: string,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return this.get(`/api/v1/jobs/${jobId}/extractions`, query);
  }

  // -----------------------------------------------------------------------
  // Entities
  // -----------------------------------------------------------------------

  async listEntities(
    jobId: string,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return this.get(`/api/v1/jobs/${jobId}/entities`, query);
  }

  async getEntity(
    jobId: string,
    entityId: string,
  ): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/entities/${entityId}`);
  }

  async listEntitiesPaginated(
    jobId: string,
    query?: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/entities`, query);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown network error';
      throw new ApiError(0, 'NETWORK_ERROR', message);
    }

    if (!response.ok) {
      let code: string | undefined;
      let message = `HTTP ${response.status}`;
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        const err = errorBody?.error as Record<string, unknown> | undefined;
        if (err) {
          code = err.code as string | undefined;
          message = (err.message as string) ?? message;
        }
      } catch {
        // Response body was not valid JSON
      }
      throw new ApiError(response.status, code, message);
    }

    const json = (await response.json()) as { data: Record<string, unknown>[]; total: number };
    return { data: json.data, total: json.total };
  }

  // -----------------------------------------------------------------------
  // Exports
  // -----------------------------------------------------------------------

  async createExport(
    jobId: string,
    body: { format: string; includeProvenance?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/jobs/${jobId}/export`, body);
  }

  async getExport(
    jobId: string,
    exportId: string,
  ): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/export/${exportId}`);
  }

  async downloadExport(
    jobId: string,
    exportId: string,
  ): Promise<string> {
    // This method bypasses the generic request() helper because the download
    // endpoint returns raw file content (not JSON wrapped in { data: ... }).
    // It uses response.text() instead of response.json().
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/export/${exportId}/download`);

    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown network error';
      throw new ApiError(0, 'NETWORK_ERROR', message);
    }

    if (!response.ok) {
      let code: string | undefined;
      let message = `HTTP ${response.status}`;
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        const err = errorBody?.error as Record<string, unknown> | undefined;
        if (err) {
          code = err.code as string | undefined;
          message = (err.message as string) ?? message;
        }
      } catch {
        // not JSON error body
      }
      throw new ApiError(response.status, code, message);
    }

    return response.text();
  }

  async getDocumentation(
    jobId: string,
  ): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/documentation`);
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async listActions(
    jobId: string,
    query?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return this.get(`/api/v1/jobs/${jobId}/actions`, query);
  }

  async approveAction(
    jobId: string,
    actionId: string,
    reviewedBy?: string,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (reviewedBy !== undefined) {
      body.reviewedBy = reviewedBy;
    }
    return this.post(
      `/api/v1/jobs/${jobId}/actions/${actionId}/approve`,
      body,
    );
  }

  async rejectAction(
    jobId: string,
    actionId: string,
    reviewedBy?: string,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (reviewedBy !== undefined) {
      body.reviewedBy = reviewedBy;
    }
    return this.post(
      `/api/v1/jobs/${jobId}/actions/${actionId}/reject`,
      body,
    );
  }

  async approveAllActions(
    jobId: string,
    reviewedBy?: string,
  ): Promise<Record<string, unknown>[]> {
    const body: Record<string, unknown> = {};
    if (reviewedBy !== undefined) {
      body.reviewedBy = reviewedBy;
    }
    return this.post(`/api/v1/jobs/${jobId}/actions/approve-all`, body);
  }

  // -----------------------------------------------------------------------
  // Billing (for remote verification)
  // -----------------------------------------------------------------------

  async getSubscription(): Promise<Record<string, unknown>> {
    return this.get('/api/v1/billing/subscription');
  }

  // -----------------------------------------------------------------------
  // Entity streaming (for pull flow)
  // -----------------------------------------------------------------------

  async getEntitiesStream(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/jobs/${jobId}/entities`, query);
  }

  /**
   * Cursor-based entity fetch that preserves the full pagination envelope.
   * Unlike getEntitiesStream(), this does NOT use this.get() because the
   * generic request() helper strips the response down to json.data only.
   */
  async getEntitiesStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/entities`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: query.limit } : {}),
    });
    return this.fetchPaginated(url);
  }

  async getExtractionsStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/extractions`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: query.limit } : {}),
    });
    return this.fetchPaginated(url);
  }

  async getActionsStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/actions`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: query.limit } : {}),
    });
    return this.fetchPaginated(url);
  }

  async getEntitySourcesStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/entity-sources`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: query.limit } : {}),
    });
    return this.fetchPaginated(url);
  }

  /**
   * Fetches tenant-wide LLM usage statistics.
   * Defaults to the last 30 days if no period is specified.
   */
  async getUsage(query?: { period?: string }): Promise<{
    period: { start: string; end: string };
    totalTokens: number;
    totalCostUsd: number;
    byModel: Record<string, { tokens: number; costUsd: number }>;
    byPurpose: Record<string, { tokens: number; costUsd: number }>;
    byJob: Array<{ jobId: string; tokens: number; costUsd: number }>;
  }> {
    return this.get('/api/v1/usage', {
      period: query?.period ?? '30d',
    });
  }

  // -----------------------------------------------------------------------
  // WebSocket token
  // -----------------------------------------------------------------------

  async getWsToken(): Promise<{ token: string; expiresIn: number }> {
    return this.post('/api/v1/ws-token');
  }

  // -----------------------------------------------------------------------
  // Health check (raw — not wrapped in { data })
  // -----------------------------------------------------------------------

  async getHealth(): Promise<Record<string, unknown>> {
    const url = this.buildUrl('/health');
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown network error';
      throw new ApiError(0, 'NETWORK_ERROR', message);
    }
    if (!response.ok) {
      throw new ApiError(response.status, undefined, `HTTP ${response.status}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': this.tenantId,
    };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  /**
   * Shared fetch + parse logic for cursor-paginated endpoints.
   * Returns the full { data, pagination } envelope without going through
   * the generic request() helper (which strips responses down to json.data).
   */
  private async fetchPaginated(url: string): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      throw new ApiError(0, 'NETWORK_ERROR', (err as Error).message);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(
        response.status,
        (body as { error?: { code?: string } }).error?.code,
        (body as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`,
      );
    }

    const json = await response.json();
    return {
      data: ((json as { data?: unknown }).data ?? []) as Record<string, unknown>[],
      pagination: (json as { pagination?: unknown }).pagination as {
        nextCursor?: string; hasMore: boolean; total: number;
      },
    };
  }

  /**
   * Build a URL with optional query parameters.
   * Null / undefined values are silently dropped.
   */
  private buildUrl(
    path: string,
    query?: Record<string, unknown>,
  ): string {
    let url = `${this.baseUrl}${path}`;

    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) {
        url += `?${qs}`;
      }
    }

    return url;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async get<T = any>(
    path: string,
    query?: Record<string, unknown>,
  ): Promise<T> {
    return this.request('GET', path, undefined, query);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async post<T = any>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return this.request('POST', path, body);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request<T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, unknown>,
  ): Promise<T> {
    const url = this.buildUrl(path, query);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown network error';
      throw new ApiError(0, 'NETWORK_ERROR', message);
    }

    if (!response.ok) {
      let code: string | undefined;
      let message = `HTTP ${response.status}`;
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        const err = errorBody?.error as Record<string, unknown> | undefined;
        if (err) {
          code = err.code as string | undefined;
          message = (err.message as string) ?? message;
        }
      } catch {
        // Response body was not valid JSON — fall through with defaults
      }
      throw new ApiError(response.status, code, message);
    }

    const json = (await response.json()) as Record<string, unknown>;
    return json.data as T;
  }
}
