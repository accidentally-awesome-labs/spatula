import type {
  ApplySummary,
  DatasetStatus,
  Definition,
  EvalScores,
  EvalView,
  GivenParts,
  ItemView,
  ReviewView,
  RunView,
  Taxonomy,
  TaxonomySeed,
} from '@spatula/core';
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

    /**
     * Starts a run, or finds the run in its way: the one already started in this five-minute slot,
     * or an earlier one still going. `message` is what the API said of that run, if it said.
     */
    async startRun(
      datasetId: string,
      options: { all?: boolean; backfill?: boolean } = {},
    ): Promise<{ runId: string; existing: boolean; message: string | null }> {
      // A backfill run reads no page, so the API takes one flag or the other.
      const query =
        options.backfill === true ? '?backfill=1' : options.all === true ? '?all=1' : '';
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/runs${query}`,
      );
      const answer = await json(response);
      if (
        (response.status === 202 || response.status === 409) &&
        typeof answer.runId === 'string'
      ) {
        return {
          runId: answer.runId,
          existing: response.status === 409,
          message: typeof answer.error === 'string' ? answer.error : null,
        };
      }
      throw refused(response.status, answer);
    },

    async getRun(runId: string): Promise<RunView> {
      const response = await request('GET', `/runs/${encodeURIComponent(runId)}`);
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return answer as unknown as RunView;
    },

    async reviveItems(
      datasetId: string,
      body: { refused?: true; irrelevant?: true; fromCaptures?: true; pages?: string[] },
    ): Promise<{ revived: number }> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/items/revive`,
        body,
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return { revived: Number(answer.revived) };
    },

    async reviveSources(datasetId: string, sources: string[]): Promise<{ revived: number }> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/sources/revive`,
        { sources },
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return { revived: Number(answer.revived) };
    },

    async purgeCaptures(
      datasetId: string,
      sourceId: string,
    ): Promise<{ captures: number; pages: number; bodies: number }> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/captures/purge`,
        { source: sourceId },
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      const purged =
        typeof answer.purged === 'object' && answer.purged !== null
          ? (answer.purged as Record<string, unknown>)
          : {};
      return {
        captures: Number(purged.captures ?? 0),
        pages: Number(purged.pages ?? 0),
        bodies: Number(purged.bodies ?? 0),
      };
    },

    async seedTaxonomy(
      datasetId: string,
      seed: TaxonomySeed,
    ): Promise<{ version: number; shelves: number; functions: number; features: number }> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/taxonomy`,
        seed,
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return {
        version: Number(answer.version),
        shelves: Number(answer.shelves),
        functions: Number(answer.functions),
        features: Number(answer.features),
      };
    },

    async getTaxonomy(
      datasetId: string,
      format?: 'export',
    ): Promise<{ version: number; taxonomy?: Taxonomy; export?: TaxonomySeed }> {
      const query = format === undefined ? '' : `?format=${format}`;
      const response = await request(
        'GET',
        `/datasets/${encodeURIComponent(datasetId)}/taxonomy${query}`,
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return answer as unknown as { version: number; taxonomy?: Taxonomy; export?: TaxonomySeed };
    },

    /** The open questions the filters let through; with none, it asks what it always asked. */
    async listReviews(datasetId: string, filters: ReviewFilters = {}): Promise<ReviewView[]> {
      const query = new URLSearchParams();
      if (filters.kind !== undefined) query.set('kind', filters.kind);
      if (filters.shelf !== undefined) query.set('shelf', filters.shelf);
      if (filters.source !== undefined) query.set('source', filters.source);
      if (filters.below !== undefined) query.set('below', String(filters.below));
      const search = query.toString();
      const response = await request(
        'GET',
        `/datasets/${encodeURIComponent(datasetId)}/review${search === '' ? '' : `?${search}`}`,
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return Array.isArray(answer.reviews) ? (answer.reviews as ReviewView[]) : [];
    },

    async answerReview(
      datasetId: string,
      reviewId: string,
      answer: string,
    ): Promise<{ effect: string }> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/review/${encodeURIComponent(reviewId)}`,
        { answer },
      );
      const body = await json(response);
      if (!response.ok) throw refused(response.status, body);
      return { effect: typeof body.effect === 'string' ? body.effect : '' };
    },

    /** Answers a question in parts, or with its suggestion (ADR 0009). */
    async answerParts(
      datasetId: string,
      reviewId: string,
      body: { parts: GivenParts; note?: string } | { suggestion: true },
    ): Promise<{ effect: string }> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/review/${encodeURIComponent(reviewId)}`,
        body,
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return { effect: textOf(answer.effect) };
    },

    /** Sends up to 500 answers in one request. Each is taken or refused on its own. */
    async answerBulk(
      datasetId: string,
      body: { answers: BulkAnswer[]; note?: string },
    ): Promise<BulkResult[]> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/review/bulk`,
        body,
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return objectsOf(answer.results).map((row) => ({
        reviewId: textOf(row.reviewId),
        status: Number(row.status) || 0,
        effect: textOf(row.effect),
        error: textOf(row.error),
      }));
    },

    /** The owner's suggested answers, each for the open question about the page it names. */
    async suggest(
      datasetId: string,
      suggestions: { page: string; parts: GivenParts }[],
    ): Promise<SuggestResult[]> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/review/suggestions`,
        { suggestions },
      );
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return objectsOf(answer.suggestions).map((row) => ({
        page: textOf(row.page),
        status: Number(row.status) || 0,
        reviewId: typeof row.reviewId === 'string' ? row.reviewId : null,
        error: textOf(row.error),
      }));
    },

    async getStatus(datasetId: string): Promise<DatasetStatus> {
      const response = await request('GET', `/datasets/${encodeURIComponent(datasetId)}/status`);
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return answer as unknown as DatasetStatus;
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

    async listItems(datasetId: string): Promise<ItemView[]> {
      const response = await request('GET', `/datasets/${encodeURIComponent(datasetId)}/items`);
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return Array.isArray(answer.items) ? (answer.items as ItemView[]) : [];
    },

    async saveEval(
      datasetId: string,
      body: { generation: number; goldenVersion: number; scores: EvalScores },
    ): Promise<void> {
      const response = await request(
        'POST',
        `/datasets/${encodeURIComponent(datasetId)}/evals`,
        body,
      );
      if (!response.ok) throw refused(response.status, await json(response));
    },

    async listEvals(datasetId: string): Promise<EvalView[]> {
      const response = await request('GET', `/datasets/${encodeURIComponent(datasetId)}/evals`);
      const answer = await json(response);
      if (!response.ok) throw refused(response.status, answer);
      return Array.isArray(answer.evals) ? (answer.evals as EvalView[]) : [];
    },
  };
}

export type Client = ReturnType<typeof createClient>;

/** What a list of questions can be filtered by: the review API's filters (ADR 0009). */
export interface ReviewFilters {
  kind?: ReviewView['kind'];
  /** A shelf, by slug or ID: the questions about pages proposed for it, or settled on it. */
  shelf?: string;
  source?: string;
  /** The questions whose likeliest answer is less likely than this. */
  below?: number;
}

/** One answer of a bulk request: one of the question's answers, its parts, or its suggestion. */
export type BulkAnswer =
  | { reviewId: string; answer: string }
  | { reviewId: string; parts: GivenParts }
  | { reviewId: string; suggestion: true };

/**
 * How one answer of a bulk request went, as the API says it: the status the answer would have got
 * alone (200 answered, 202 sent to the owner, anything else refused), and for a refusal its reason.
 */
export interface BulkResult {
  reviewId: string;
  status: number;
  effect: string;
  error: string;
}

/** How one suggestion went: 200, on the question it's now on, or why not. */
export interface SuggestResult {
  page: string;
  status: number;
  reviewId: string | null;
  error: string;
}

/** The objects in a list an answer holds; a newer API's extra fields don't matter. */
function objectsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    : [];
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
