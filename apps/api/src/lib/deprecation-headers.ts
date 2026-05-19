import type { Context } from 'hono';

/**
 * Phase 16 plan 16-1: HTTP Deprecation/Sunset headers per RFC 8594.
 *
 * Emitted from routes that still serve a deprecated request shape (e.g.,
 * offset-paginated list endpoints). v2.0 will remove these surfaces; clients
 * SHOULD migrate to the successor before the Sunset date.
 *
 * Sunset target: 2027-05-01 (~12 months post v1.0 launch). Update when v2 is
 * planned. For v1.0 we hardcode the Deprecation date to the build time of
 * this module — acceptable because v1.0 deprecates these surfaces "as of
 * launch", not at a future date.
 */
const SUNSET_DATE = new Date('2027-05-01T00:00:00.000Z');
const SUNSET_HTTP_DATE = SUNSET_DATE.toUTCString();

// Deprecation header value: the date the surface became deprecated. For v1.0
// surfaces, that's "as of launch" — frozen at module-load time on the running
// process. Acceptable per RFC 8594 (the header is informational; consumers
// should drive on the Sunset value).
const DEPRECATION_HTTP_DATE = new Date().toUTCString();

const DEFAULT_SUCCESSOR_LINK = '</docs/compat-policy>; rel="successor-version"';

export interface DeprecationHeaderOptions {
  /**
   * RFC 8288 Link header value. Defaults to a pointer at the compat policy
   * doc; routes that have a route-specific successor can override (e.g.,
   * `</api/v1/entities?cursor=...>; rel="successor-version"`).
   */
  successorLink?: string;
}

/**
 * Writes the three v1 deprecation headers to `c.res`:
 *   - `Deprecation` — HTTP-date the surface became deprecated.
 *   - `Sunset`      — HTTP-date the surface will be removed (v2.0 target).
 *   - `Link`        — rel="successor-version" pointer to the replacement.
 *
 * Callers should invoke BEFORE `return c.json(...)`.
 */
export function applyDeprecationHeaders(
  c: Context,
  options?: DeprecationHeaderOptions,
): void {
  c.header('Deprecation', DEPRECATION_HTTP_DATE);
  c.header('Sunset', SUNSET_HTTP_DATE);
  c.header('Link', options?.successorLink ?? DEFAULT_SUCCESSOR_LINK);
}
