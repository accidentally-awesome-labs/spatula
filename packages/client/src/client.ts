/**
 * `SpatulaClient` — the entry-point class for the Spatula JavaScript SDK.
 *
 * Properties (per spec §3.2.1):
 * - ESM-only; `sideEffects: false`; browser + Node 22+ compatible
 * - Constructor performs NO I/O (Anti-Pattern "Constructor I/O" — D-12)
 * - All HTTP calls go through `request()`, which decodes the API error
 *   envelope `{error:{code,message,requestId,details?}}` into the matching
 *   class-per-code subclass instance (generated in `./errors/generated.ts`)
 *
 * The lazy version-probe (D-12) wires into this class in plan 16-3; this plan
 * only reserves the constructor signature.
 */
import { SpatulaApiError } from './errors/base.js';
import { decodeError } from './errors/generated.js';
import { createExperimentalNamespace } from './experimental/index.js';

export interface SpatulaClientOptions {
  /** Base URL of the Spatula API (e.g., `https://api.spatula.dev`). */
  baseUrl: string;
  /** API key or bearer token sent in the `Authorization: Bearer ...` header. */
  apiKey: string;
  /** Optional fetch override (defaults to global `fetch`). Useful for tests. */
  fetch?: typeof fetch;
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
  /**
   * Reserved namespace for future experimental surfaces. v1.0 ships zero
   * experimental endpoints; any property access throws (see
   * `./experimental/index.ts`).
   */
  readonly experimental: Record<string, never>;

  constructor(opts: SpatulaClientOptions) {
    // Strict: NO I/O in the constructor (D-12). Store config only.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.experimental = createExperimentalNamespace();
  }

  /**
   * Issue an HTTP request against the Spatula API.
   *
   * On 2xx — parses JSON and returns it as `T`.
   * On non-2xx — parses the error envelope and throws the matching class-
   * per-code subclass (from `./errors/generated.ts`), falling back to a
   * generic `SpatulaApiError` if the code is unknown.
   */
  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
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
