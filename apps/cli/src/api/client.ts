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
// Client
// ---------------------------------------------------------------------------

export class SpatulaApiClient {
  private readonly baseUrl: string;
  private readonly tenantId: string;

  constructor(baseUrl: string, tenantId: string) {
    // Strip trailing slash so callers don't need to worry about it
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tenantId = tenantId;
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
  // Internal helpers
  // -----------------------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-tenant-id': this.tenantId,
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
