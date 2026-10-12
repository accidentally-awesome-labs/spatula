import type { ApplySummary, Definition, RunView } from '@spatula/core';
import { describeError } from './format';

/** An answer the API refused with, and the problems it listed. Status 0 means no answer. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The only hosts where the owner token may travel over plain http: this machine. */
const THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The C0 controls and DEL, which a header can't hold. */
const CONTROL = /[\u{0}-\u{1f}\u{7f}]/u;

/**
 * The CLI sends the owner token to whatever SPATULA_URL names, so a mistyped http:// address for a
 * deployment would hand the token to anyone on the way. An address that doesn't parse isn't
 * refused here: the request that uses it reports it.
 */
function refuseClearText(baseUrl: string): void {
  if (!URL.canParse(baseUrl)) return;
  const { protocol, hostname } = new URL(baseUrl);
  if (protocol === 'http:' && !THIS_MACHINE.has(hostname)) {
    throw new ApiError(
      0,
      'SPATULA_URL must be an https:// address unless Spatula runs on this machine.',
    );
  }
}

/** The owner API, as the CLI uses it. */
export function createClient(options: {
  baseUrl: string;
  token: string | undefined;
  fetch?: typeof fetch;
}) {
  const send =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    // These checks run here, before any request, and not when the client is made: `main` makes one
    // before it knows the command, and commands that send nothing, such as `check`, must not be
    // held to them.
    refuseClearText(options.baseUrl);
    if (options.token === undefined) throw new ApiError(0, 'Set SPATULA_TOKEN to the owner token.');
    // fetch's error for such a token would quote the header it was put in, token and all.
    if (CONTROL.test(options.token)) {
      throw new ApiError(0, 'SPATULA_TOKEN holds a control character.');
    }
    try {
      return await send(new URL(path, options.baseUrl), {
        method,
        // The owner token goes to SPATULA_URL and nowhere else, so a redirect is an error.
        redirect: 'error',
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(0, `Spatula at ${options.baseUrl} didn’t answer: ${describeError(error)}`);
    }
  }

  async function json(response: Response): Promise<Record<string, unknown>> {
    const answer: unknown = await response.json().catch(() => null);
    return typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {};
  }

  function refused(status: number, answer: Record<string, unknown>): ApiError {
    const message =
      typeof answer.error === 'string' ? answer.error : `Spatula answered HTTP ${status}.`;
    return new ApiError(
      status,
      message,
      Array.isArray(answer.issues) ? answer.issues.map(String) : [],
    );
  }

  return {
    async applyDefinition(definition: Definition, dryRun: boolean): Promise<ApplySummary> {
      const path = `/datasets/${encodeURIComponent(definition.dataset)}${dryRun ? '?dryRun=1' : ''}`;
      const response = await request('PUT', path, definition);
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return answer as unknown as ApplySummary;
    },

    /** Starts a run, or finds the one already started in this five-minute slot. */
    async startRun(
      datasetId: string,
      options: { all?: boolean } = {},
    ): Promise<{ runId: string; existing: boolean }> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/runs${options.all === true ? '?all=1' : ''}`,
      );
      const answer = await json(response);
      if (
        (response.status === 202 || response.status === 409) &&
        typeof answer.runId === 'string'
      ) {
        return { runId: answer.runId, existing: response.status === 409 };
      }
      throw refused(response.status, answer);
    },

    async getRun(runId: string): Promise<RunView> {
      const response = await request('GET', `/runs/${encodeURIComponent(runId)}`);
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return answer as unknown as RunView;
    },

    async pullSnapshot(
      datasetId: string,
      generation: number | 'latest',
    ): Promise<{ body: string; sha256: string; generation: number; snapshotId: string }> {
      const response = await request(
        'GET',
        `/datasets/${encodeURIComponent(datasetId)}/snapshots/${generation}`,
      );
      if (!response.ok) throw refused(response.status, await json(response));
      return {
        body: await response.text(),
        sha256: response.headers.get('x-spatula-sha256') ?? '',
        generation: Number(response.headers.get('x-spatula-generation')),
        snapshotId: response.headers.get('x-spatula-snapshot-id') ?? '',
      };
    },
  };
}

export type Client = ReturnType<typeof createClient>;
