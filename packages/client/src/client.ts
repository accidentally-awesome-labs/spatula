/**
 * `SpatulaClient` — the entry-point class for the Spatula JavaScript SDK.
 *
 * Properties (per spec §3.2.1 + plan 16-3):
 * - ESM-only; `sideEffects: false`; browser + Node 22+ compatible
 * - Constructor performs NO I/O (Anti-Pattern "Constructor I/O" — D-12).
 * - All HTTP calls go through `request()`, which:
 *     1. Awaits `probe.ensure()` (zero-I/O on second+ call; lazy single-shot
 *        on first call). Throws `SpatulaVersionMismatchError` BEFORE the
 *        actual request fires if the server's major version disagrees.
 *     2. Decodes the API error envelope `{error:{code,message,requestId,details?}}`
 *        into the matching class-per-code subclass instance (generated in
 *        `./errors/generated.ts`).
 *
 * The compiled-in `SDK_MAJOR_VERSION` constant is the source of truth for the
 * SDK side of the major-compat gate. Manually bump from 0 → 1 when release-
 * please promotes this package to v1.0.0.
 */
import { SpatulaApiError } from './errors/base.js';
import { decodeError } from './errors/generated.js';
import { createExperimentalNamespace } from './experimental/index.js';
import type { ExperimentalNamespace } from './experimental/index.js';
import { VersionProbe } from './version-probe.js';

/**
 * Hard-coded SDK major version. The 0.x series corresponds to phase-16 pre-
 * release; release-please will bump this package to 1.0.0 at v1.0 launch — at
 * that point also update this constant to `1`. Keeping it manual (rather than
 * reading package.json at runtime) avoids JSON-module / bundler import paths.
 */
const SDK_MAJOR_VERSION = 0;

export interface SpatulaClientOptions {
  /** Base URL of the Spatula API (e.g., `https://api.spatula.dev`). */
  baseUrl: string;
  /** API key or bearer token sent in the `Authorization: Bearer ...` header. */
  apiKey: string;
  /** Optional fetch override (defaults to global `fetch`). Useful for tests. */
  fetch?: typeof fetch;
  /**
   * If true, suppress the lazy version probe before every request. Use for
   * tests, mocked servers, or offline scenarios where /.well-known is known
   * to be absent. Defaults to false.
   */
  skipVersionProbe?: boolean;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

export class SpatulaClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly skipVersionProbe: boolean;
  private readonly probe: VersionProbe;
  /**
   * Experimental surfaces namespace. v1.0 ships ONE experimental surface:
   * `client.experimental.forensic.*` for the forensic-extractions admin endpoint.
   * All other property accesses throw fail-loud (see `./experimental/index.ts`).
   */
  readonly experimental: ExperimentalNamespace;

  constructor(opts: SpatulaClientOptions) {
    // Strict: NO I/O in the constructor (D-12). Store config + wire probe.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.skipVersionProbe = opts.skipVersionProbe ?? false;
    this.probe = new VersionProbe({
      baseUrl: this.baseUrl,
      fetcher: this.fetchImpl,
      sdkMajor: SDK_MAJOR_VERSION,
    });
    // Pass `this` as the transport so forensic surface reuses the same
    // request() helper (version probe + auth + error-envelope decoding).
    this.experimental = createExperimentalNamespace(this);
  }

  /**
   * Issue an HTTP request against the Spatula API.
   *
   * Awaits `probe.ensure()` before the request fires (unless
   * `skipVersionProbe: true` was passed at construction).
   *
   * On 2xx — parses JSON and returns it as `T`.
   * On non-2xx — parses the error envelope and throws the matching class-
   * per-code subclass (from `./errors/generated.ts`), falling back to a
   * generic `SpatulaApiError` if the code is unknown.
   */
  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    if (!this.skipVersionProbe) {
      await this.probe.ensure();
    }

    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.ok) {
      // 204 No Content — return undefined-as-T (caller declares the type).
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }

    let envelope: ApiErrorEnvelope;
    try {
      const parsed = (await response.json()) as { error?: ApiErrorEnvelope };
      envelope = parsed.error ?? {
        code: 'INTERNAL.ERROR',
        message: `Unparseable error envelope (HTTP ${response.status})`,
        requestId: response.headers.get('x-request-id') ?? 'unknown',
      };
    } catch {
      envelope = {
        code: 'INTERNAL.ERROR',
        message: `HTTP ${response.status} ${response.statusText}`,
        requestId: response.headers.get('x-request-id') ?? 'unknown',
      };
    }

    throw decodeError(envelope, response.status);
  }
}

export { SpatulaApiError };
