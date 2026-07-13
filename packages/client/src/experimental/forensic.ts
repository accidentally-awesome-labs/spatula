/**
 * `client.experimental.forensic.*` SDK surface.
 *
 * The forensic surface is the FIRST and ONLY experimental surface in Spatula v1.0.
 * It is accessible via `client.experimental.forensic.*` and calls
 * `GET /api/v1/admin/forensic/extractions`.
 *
 * See docs/deprecation-policy.md for the experimental surface policy:
 * - Experimental surfaces have a 6-month maximum lifetime.
 * - They may change or be removed without a deprecation period.
 * - Callers should use `client.experimental.forensic.*` to make dependence explicit.
 *
 * The transport pattern mirrors other SDK methods — uses the SpatulaClient.request()
 * helper which handles version probing, auth headers, and error-envelope decoding.
 */

/** Params for listExtractions — all optional. */
export interface ListForensicExtractionsParams {
  /** Opaque pagination cursor from a previous response. Treat as opaque — do not parse. */
  cursor?: string;
  /** Max number of items to return (1–100, default 50). */
  limit?: number;
}

/** Shape of a single forensic extraction item in the API response. */
export interface ForensicExtractionItem {
  /** DLQ record ID. */
  id: string;
  /** The extraction ID that triggered the forensic archival. */
  extractionId: string;
  /** Tenant that owns the extraction. */
  tenantId: string;
  /** Why archival was triggered. */
  reason: string;
  /** ISO-8601 timestamp when the forensic record was created. */
  createdAt: string;
  /**
   * Signed URL to the raw HTML blob (15-minute TTL).
   * Fetch this URL to retrieve the raw HTML for forensic analysis.
   * Never contains inline HTML — only a signed URL.
   */
  contentRef: string;
}

/** Response shape from GET /api/v1/admin/forensic/extractions. */
export interface ForensicExtractionsResponse {
  data: ForensicExtractionItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Minimal transport interface needed by the forensic surface. */
export interface ForensicTransport {
  request<T>(method: 'GET', path: string): Promise<T>;
  readonly baseUrl: string;
}

/**
 * Factory for the `forensic` experimental surface.
 *
 * The `transport` is expected to be the `SpatulaClient` instance, which
 * exposes `request(method, path, body?)` and `baseUrl`. We accept a
 * structural interface to keep this module testable in isolation.
 */
export function createForensicSurface(transport: ForensicTransport) {
  return {
    /**
     * List forensic extraction records.
     *
     * Calls `GET /api/v1/admin/forensic/extractions` with optional cursor/limit.
     * Returns the cursor-first `{ data, nextCursor, hasMore }` shape.
     *
     * Requires the `admin:forensic:read` scope (or `admin` superset).
     * Throws a `SpatulaApiError` subclass on 4xx/5xx responses.
     */
    async listExtractions(
      params?: ListForensicExtractionsParams,
    ): Promise<ForensicExtractionsResponse> {
      // Build query string from params
      const query = new URLSearchParams();
      if (params?.cursor) query.set('cursor', params.cursor);
      if (params?.limit !== undefined) query.set('limit', String(params.limit));

      const queryStr = query.toString();
      const path = `/api/v1/admin/forensic/extractions${queryStr ? `?${queryStr}` : ''}`;

      return transport.request<ForensicExtractionsResponse>('GET', path);
    },
  };
}
