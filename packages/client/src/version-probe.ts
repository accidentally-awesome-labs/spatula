/**
 * Lazy version probe.
 *
 * `VersionProbe.ensure()` is awaited at the top of every `SpatulaClient.request()`
 * call. It fires `GET /.well-known/spatula-version` AT MOST ONCE per client
 * lifetime (the result is cached) and throws `SpatulaVersionMismatchError`
 * BEFORE the user's actual request fires when the server's major version
 * disagrees with the SDK's compiled-in `SDK_MAJOR_VERSION`.
 *
 * Two distinct failure modes get DIFFERENT cache semantics:
 *
 *   1. SpatulaVersionMismatchError (major-version drift):
 *      Cache the REJECTED promise. Every subsequent .ensure() re-throws the
 *      same verdict without making another HTTP call. The server's major
 *      version doesn't change in seconds; we have a verdict.
 *
 *   2. Transient transport error (fetch reject, 5xx-as-thrown, timeout):
 *      Reset probePromise = null so the next .ensure() retries. The server
 *      may come back; transient failures shouldn't permanently disable the
 *      client.
 *
 * Graceful degradation:
 *   - 404 (or any non-200 OK-false status) is treated as "unknown server" —
 *     the probe does NOT throw, so the SDK can talk to non-Spatula servers
 *     or older Spatula releases that don't expose /.well-known.
 *   - Body without a parseable `version` field also degrades gracefully.
 *
 * SSR-safe: the constructor of `SpatulaClient` performs zero I/O. The probe
 * fires only when `.ensure()` is awaited — which happens at first `request()`,
 * not at module evaluation time.
 */
import { SpatulaVersionMismatchError } from './errors/base.js';

export interface VersionProbeOptions {
  baseUrl: string;
  fetcher: typeof fetch;
  sdkMajor: number;
}

export class VersionProbe {
  private probePromise: Promise<void> | null = null;

  constructor(private readonly opts: VersionProbeOptions) {}

  /**
   * Returns a Promise that resolves once we have a major-compat verdict
   * for the configured server. Cached for the client lifetime on a verdict
   * (success OR version-mismatch); reset on transient transport failure
   * so the next call can retry.
   */
  ensure(): Promise<void> {
    if (this.probePromise !== null) return this.probePromise;

    this.probePromise = this.run().catch((err) => {
      if (err instanceof SpatulaVersionMismatchError) {
        // VERDICT — cache the rejected promise; never retry.
        throw err;
      }
      // Transport / unexpected error — reset so the next .ensure() retries.
      this.probePromise = null;
      throw err;
    });

    return this.probePromise;
  }

  private async run(): Promise<void> {
    const url = `${this.opts.baseUrl}/.well-known/spatula-version`;
    const res = await this.opts.fetcher(url);

    if (!res.ok) {
      // Treat a missing endpoint (or 5xx) as "unknown server" — degrade
      // gracefully. The mismatch gate fires ONLY on a successful response
      // that disagrees. Consumers wanting fail-fast on 5xx can opt out via
      // `skipVersionProbe: true`.
      return;
    }

    let body: { version?: unknown };
    try {
      body = (await res.json()) as { version?: unknown };
    } catch {
      // Unparseable body — degrade gracefully.
      return;
    }

    if (typeof body.version !== 'string') return;

    const majorStr = body.version.split('.')[0];
    const serverMajor = Number.parseInt(majorStr ?? '', 10);
    if (Number.isNaN(serverMajor)) return;

    if (serverMajor !== this.opts.sdkMajor) {
      throw new SpatulaVersionMismatchError({
        code: 'VERSION.MISMATCH',
        message: `SDK major v${this.opts.sdkMajor} cannot speak to server major v${serverMajor}. See docs/compat-policy.md.`,
        status: 426,
        requestId: 'sdk-version-probe',
        details: {
          sdkMajor: this.opts.sdkMajor,
          serverMajor,
          serverVersion: body.version,
        },
      });
    }
  }
}
