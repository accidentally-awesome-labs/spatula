import {
  goldenSetSchema,
  packIssues,
  parseDefinition,
  RUN_SLOT_TAKEN,
  scoreDataset,
  sha256Hex,
  snapshotSchema,
  taxonomySeedSchema,
  type Definition,
  type GivenParts,
  type GoldenSet,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import { parse, stringify } from 'yaml';
import { ApiError, type BulkAnswer, type Client, type ReviewFilters } from './client';
import {
  describeError,
  formatApplySummary,
  formatComparison,
  formatEvals,
  formatReviews,
  formatRun,
  formatScores,
  formatStatus,
} from './format';

/** Everything the commands do outside themselves, so tests can run them in memory. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** How often `run --wait` asks how the run is going. */
export const POLL_MS = 2000;

/** How long `run --wait` keeps asking before it stops waiting. */
export const WAIT_LIMIT_MS = 60 * 60 * 1000;

/** A definition file, read and checked as the API will check it. Its problems are printed. */
export async function readDefinition(io: Io, file: string): Promise<Definition | null> {
  let text: string;
  try {
    text = await io.readFile(file);
  } catch (error) {
    io.err(`${file} can’t be read: ${describeError(error)}`);
    return null;
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    // The YAML library's message shows the line it stopped at under its first line. Each line is
    // printed by a call of its own.
    const [first = '', ...frame] = describeError(error).split('\n');
    io.err(`${file} isn’t valid YAML: ${first}`);
    for (const line of frame) io.err(line);
    return null;
  }
  const parsed = parseDefinition(data);
  const issues = parsed.ok ? packIssues(parsed.definition, packs) : parsed.issues;
  if (!parsed.ok || issues.length > 0) {
    io.err(`${file} has ${issues.length === 1 ? 'a problem' : `${issues.length} problems`}:`);
    for (const issue of issues) io.err(`  ${issue}`);
    return null;
  }
  return parsed.definition;
}

export async function check(io: Io, file: string): Promise<number> {
  const definition = await readDefinition(io, file);
  if (definition === null) return 1;
  let pages = 0;
  let sitemaps = 0;
  for (const source of definition.sources) {
    if (source.kind === 'pages') pages += source.pages.length;
    else sitemaps += source.sitemaps.length;
  }
  const types = Object.keys(definition.recordTypes).length;
  const listed = [
    count(types, 'record type'),
    count(definition.sources.length, 'source'),
    ...(pages > 0 || sitemaps === 0 ? [count(pages, 'page')] : []),
    ...(sitemaps > 0 ? [count(sitemaps, 'sitemap')] : []),
  ];
  io.out(`${definition.dataset}: ${listed.join(', ')}. Nothing is wrong with it.`);
  return 0;
}

/** `plan` previews applying a definition; `apply` applies it. */
export async function plan(
  io: Io,
  client: Client,
  file: string,
  options: { apply: boolean },
): Promise<number> {
  const definition = await readDefinition(io, file);
  if (definition === null) return 1;
  return withApi(io, async () => {
    const summary = await client.applyDefinition(definition, !options.apply);
    for (const line of formatApplySummary(summary, !options.apply)) io.out(line);
    return 0;
  });
}

export async function run(
  io: Io,
  client: Client,
  datasetId: string,
  options: { wait: boolean; all: boolean; backfill?: boolean },
): Promise<number> {
  return withApi(io, async () => {
    const { runId, existing, message } = await client.startRun(datasetId, {
      all: options.all,
      backfill: options.backfill === true,
    });
    // The API names a run of an earlier slot that is still going in its own words. The run asked
    // for never started, so this is a refusal, and the other run is not followed: a script that
    // waits for this run would go on to use the result of one that isn't it. The slot's sentence is
    // the CLI's, with the run's ID, for the run this one repeats, which is followed.
    if (existing && message !== null && message !== RUN_SLOT_TAKEN) {
      io.err(message);
      return 1;
    }
    io.out(
      existing ? `A run already started in this five-minute slot: ${runId}.` : `Started ${runId}.`,
    );
    if (!options.wait) return 0;
    // The API answers running until a run finishes, so a stuck or misreported run would keep this
    // asking for ever.
    for (let polls = 0; polls < WAIT_LIMIT_MS / POLL_MS; polls += 1) {
      const view = await client.getRun(runId);
      if (view.status !== 'running') {
        for (const line of formatRun(view)) io.out(line);
        return view.status === 'complete' ? 0 : 1;
      }
      await io.sleep(POLL_MS);
    }
    io.err(`Stopped waiting after ${WAIT_LIMIT_MS / 60_000} minutes; ${runId} is still running.`);
    return 1;
  });
}

/**
 * Starts a model comparison (ADR 0010), which asks a dataset's answered questions again of a model
 * and spends up to `maxUsd`, and with `wait` prints its report. A comparison that failed exits 1.
 */
export async function compareModels(
  io: Io,
  client: Client,
  datasetId: string,
  options: {
    job: string;
    model: string;
    backup?: string;
    accept?: number;
    limit?: number;
    maxUsd: number;
    wait: boolean;
  },
): Promise<number> {
  return withApi(io, async () => {
    const { wait, ...body } = options;
    const { comparisonId } = await client.startComparison(datasetId, body);
    io.out(`Started ${comparisonId}.`);
    if (!wait) {
      io.out(`Read its report with: spatula models comparison ${comparisonId}`);
      return 0;
    }
    for (let polls = 0; polls < WAIT_LIMIT_MS / POLL_MS; polls += 1) {
      const view = await client.getComparison(comparisonId);
      if (view.status === 'complete') {
        for (const line of formatComparison(view.report)) io.out(line);
        return 0;
      }
      if (view.status === 'failed') {
        io.err(view.error);
        return 1;
      }
      await io.sleep(POLL_MS);
    }
    io.err(
      `Stopped waiting after ${WAIT_LIMIT_MS / 60_000} minutes; ${comparisonId} is still running.`,
    );
    return 1;
  });
}

/** A comparison's report, or that it is still going. */
export async function showComparison(
  io: Io,
  client: Client,
  comparisonId: string,
): Promise<number> {
  return withApi(io, async () => {
    const view = await client.getComparison(comparisonId);
    if (view.status === 'running') {
      io.out(`Comparison ${comparisonId} is still running.`);
      return 0;
    }
    if (view.status === 'failed') {
      io.err(view.error);
      return 1;
    }
    for (const line of formatComparison(view.report)) io.out(line);
    return 0;
  });
}

/**
 * Puts sources back (ADR 0006), then refused pages, irrelevant ones, or the pages named, for the
 * next run. A source put back starts its count of blocked runs again, and a refused one is live.
 * With `fromCaptures`, an irrelevant page whose capture holds its stored copy is read again from it,
 * with no request, once its code is older (ADR 0008).
 */
export async function revive(
  io: Io,
  client: Client,
  datasetId: string,
  options: {
    refused: boolean;
    irrelevant: boolean;
    fromCaptures: boolean;
    pages: string[];
    sources: string[];
  },
): Promise<number> {
  return withApi(io, async () => {
    if (options.sources.length > 0) {
      const { revived } = await client.reviveSources(datasetId, options.sources);
      io.out(
        revived === 0
          ? `No source named was blocked or refused in ${datasetId}, so none was revived.`
          : `Revived ${count(revived, 'source')} of ${datasetId}. The next run reads ${revived === 1 ? 'its' : 'their'} due pages.`,
      );
    }
    if (!options.refused && !options.irrelevant && options.pages.length === 0) return 0;
    const { revived } = await client.reviveItems(datasetId, {
      ...(options.refused ? { refused: true as const } : {}),
      ...(options.irrelevant ? { irrelevant: true as const } : {}),
      ...(options.fromCaptures ? { fromCaptures: true as const } : {}),
      ...(options.pages.length > 0 ? { pages: options.pages } : {}),
    });
    io.out(
      revived === 0
        ? `Nothing matched in ${datasetId}, so no page was revived.`
        : `Revived ${count(revived, 'page')} of ${datasetId}. The next run reads them.`,
    );
    return 0;
  });
}

/**
 * Deletes a source's page captures, and its pages' stored copies (ADR 0008). The source's statements
 * stay, and so does the source, whose next run captures its pages again.
 */
export async function purge(
  io: Io,
  client: Client,
  datasetId: string,
  sourceId: string,
): Promise<number> {
  return withApi(io, async () => {
    const purged = await client.purgeCaptures(datasetId, sourceId);
    if (purged.captures + purged.pages + purged.bodies === 0) {
      io.out(`Nothing of ${sourceId} was captured in ${datasetId}.`);
      return 0;
    }
    io.out(
      `Purged ${count(purged.captures, 'capture')} of ${sourceId} in ${datasetId}, and ${count(purged.bodies, 'stored page')}.`,
    );
    io.out(
      `The next run that reads ${sourceId}’s pages captures them again. Remove ${sourceId} from the definition if they mustn’t be read.`,
    );
    return 0;
  });
}

/** Seeds a dataset's taxonomy from a YAML file, checked here as the API checks it (ADR 0007). */
export async function seedTaxonomyFile(
  io: Io,
  client: Client,
  datasetId: string,
  file: string,
): Promise<number> {
  let data: unknown;
  try {
    data = parse(await io.readFile(file));
  } catch (error) {
    io.err(`${file} can’t be read as YAML: ${describeError(error).split('\n')[0]}`);
    return 1;
  }
  const parsed = taxonomySeedSchema.safeParse(data);
  if (!parsed.success) {
    io.err(`${file} isn’t a taxonomy seed:`);
    for (const issue of parsed.error.issues.slice(0, 20)) {
      io.err(`  ${issue.path.join('.') || '(file)'}: ${issue.message}`);
    }
    return 1;
  }
  return withApi(io, async () => {
    const seeded = await client.seedTaxonomy(datasetId, parsed.data);
    io.out(
      `Seeded ${datasetId}’s taxonomy as version ${seeded.version}: ${count(seeded.shelves, 'shelf').replace(/shelfs$/u, 'shelves')}, ${count(seeded.functions, 'function')}, and ${count(seeded.features, 'feature')}.`,
    );
    return 0;
  });
}

/** Writes the dataset's current taxonomy in the seed file's shape, with each item's ID. */
export async function exportTaxonomyFile(
  io: Io,
  client: Client,
  datasetId: string,
  out: string,
): Promise<number> {
  return withApi(io, async () => {
    const got = await client.getTaxonomy(datasetId, 'export');
    try {
      await io.writeFile(out, stringify(got.export, { lineWidth: 100 }));
    } catch (error) {
      io.err(`Couldn’t write ${out}: ${describeError(error)}`);
      return 1;
    }
    io.out(`Wrote version ${got.version} of ${datasetId}’s taxonomy to ${out}.`);
    return 0;
  });
}

/** What `spatula review` was asked to do (ADR 0009). */
export type ReviewRequest =
  | { kind: 'list'; filters: ReviewFilters }
  | { kind: 'answer'; reviewId: string; answer: string }
  | { kind: 'parts'; reviewId: string; parts: GivenParts; note?: string }
  | { kind: 'suggestion'; reviewId: string }
  | { kind: 'answers'; file: string }
  | { kind: 'suggest'; file: string };

/**
 * Lists the dataset's open questions, or answers one: with one of its answers, in parts, or with
 * its suggestion. Or sends a file of answers, or of suggestions.
 */
export async function review(
  io: Io,
  client: Client,
  datasetId: string,
  request: ReviewRequest,
): Promise<number> {
  if (request.kind === 'answers') return answerFile(io, client, datasetId, request.file);
  if (request.kind === 'suggest') return suggestFile(io, client, datasetId, request.file);
  return withApi(io, async () => {
    switch (request.kind) {
      case 'list':
        return listQuestions(io, client, datasetId, request.filters);
      case 'answer': {
        const { effect } = await client.answerReview(datasetId, request.reviewId, request.answer);
        io.out(
          `Answered ${request.reviewId}: ${request.answer}.${effect === '' ? '' : ` ${effect}`}`,
        );
        return 0;
      }
      case 'parts': {
        const { effect } = await client.answerParts(datasetId, request.reviewId, {
          parts: request.parts,
          ...(request.note === undefined ? {} : { note: request.note }),
        });
        const said = partsText(request.parts);
        io.out(`Answered ${request.reviewId}: ${said}.${effect === '' ? '' : ` ${effect}`}`);
        return 0;
      }
      case 'suggestion': {
        const { effect } = await client.answerParts(datasetId, request.reviewId, {
          suggestion: true,
        });
        io.out(
          `Answered ${request.reviewId} with its suggestion.${effect === '' ? '' : ` ${effect}`}`,
        );
        return 0;
      }
    }
  });
}

/**
 * Lists the open questions, naming a taxonomy question's parts from the taxonomy. A shelf filter
 * goes as typed: the API takes the shelf's slug as well as its ID.
 */
async function listQuestions(
  io: Io,
  client: Client,
  datasetId: string,
  filters: ReviewFilters,
): Promise<number> {
  const reviews = await client.listReviews(datasetId, filters);
  const taxonomy = reviews.some((one) => one.question.type === 'taxonomy')
    ? ((await client.getTaxonomy(datasetId)).taxonomy ?? null)
    : null;
  for (const line of formatReviews(datasetId, reviews, taxonomy)) io.out(line);
  return 0;
}

/** Parts as they were typed: "shelf on-ear, function amplifier, back=closed". */
function partsText(parts: GivenParts): string {
  const words = [
    ...(parts.shelf === undefined ? [] : [`shelf ${parts.shelf}`]),
    ...(parts.functions ?? []).map((ref) => `function ${ref}`),
    ...Object.entries(parts.features ?? {}).flatMap(([feature, values]) =>
      values.map((value) => `${feature}=${value}`),
    ),
  ];
  return words.length === 0 ? 'none of the parts offered' : words.join(', ');
}

/** The most answers one bulk request takes (ruling 13). */
const BULK_MAX = 500;

/** Sends a file of answers, `{ "answers": [...], "note"?: "..." }`, as one bulk request. */
async function answerFile(
  io: Io,
  client: Client,
  datasetId: string,
  file: string,
): Promise<number> {
  const data = await readJson(io, file);
  if (data === undefined) return 1;
  const body = bulkAnswers(data);
  if (body === null) {
    io.err(
      `${file} isn’t a file of answers: { "answers": [...] }, 1 to ${BULK_MAX} of them, each with a "reviewId".`,
    );
    return 1;
  }
  return withApi(io, async () => {
    const results = await client.answerBulk(datasetId, body);
    // Each answer has the status it would have got alone: 200 answered it, 202 sent it to the
    // owner, and anything else refused it.
    const left = results.filter((one) => one.status !== 200 && one.status !== 202);
    const answered = results.length - left.length;
    io.out(`Answered ${answered} of ${count(body.answers.length, 'question')}.`);
    for (const one of left) io.err(`  ${one.reviewId}: ${reasonOf(one)}`);
    return answered === body.answers.length ? 0 : 1;
  });
}

/** A bulk request's body, if the file holds one: the API checks each answer itself. */
function bulkAnswers(data: unknown): { answers: BulkAnswer[]; note?: string } | null {
  if (!isRecord(data) || !Array.isArray(data.answers)) return null;
  const answers: unknown[] = data.answers;
  const named = answers.every((one) => isRecord(one) && typeof one.reviewId === 'string');
  if (!named || answers.length === 0 || answers.length > BULK_MAX) return null;
  if (data.note !== undefined && typeof data.note !== 'string') return null;
  return {
    answers: answers as BulkAnswer[],
    ...(data.note === undefined ? {} : { note: data.note }),
  };
}

/** Sends the owner's suggestions, `{ "suggestions": [{ "page": ..., "parts": {...} }] }`. */
async function suggestFile(
  io: Io,
  client: Client,
  datasetId: string,
  file: string,
): Promise<number> {
  const data = await readJson(io, file);
  if (data === undefined) return 1;
  const suggestions = isRecord(data) && Array.isArray(data.suggestions) ? data.suggestions : [];
  const whole = suggestions.every(
    (one) => isRecord(one) && typeof one.page === 'string' && isRecord(one.parts),
  );
  if (suggestions.length === 0 || !whole) {
    io.err(
      `${file} isn’t a file of suggestions: { "suggestions": [...] }, each with a "page" and its "parts".`,
    );
    return 1;
  }
  const sent = suggestions as { page: string; parts: GivenParts }[];
  return withApi(io, async () => {
    const results = await client.suggest(datasetId, sent);
    const left = results.filter((one) => one.status !== 200);
    const suggested = results.length - left.length;
    io.out(`Suggested answers for ${suggested} of ${count(sent.length, 'page')}.`);
    for (const one of left) io.err(`  ${one.page}: ${reasonOf(one)}`);
    return suggested === sent.length ? 0 : 1;
  });
}

/** Why the API didn't take an answer or a suggestion: its reason, or at least its status. */
const reasonOf = (result: { status: number; error: string }): string =>
  result.error === '' ? `Spatula answered HTTP ${result.status}.` : result.error;

/** A JSON file's contents, or undefined once what's wrong with it is printed. */
async function readJson(io: Io, file: string): Promise<unknown> {
  let text: string;
  try {
    text = await io.readFile(file);
  } catch (error) {
    io.err(`${file} can’t be read: ${describeError(error)}`);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    io.err(`${file} isn’t JSON: ${describeError(error)}`);
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Says where a dataset stands. */
export async function status(io: Io, client: Client, datasetId: string): Promise<number> {
  return withApi(io, async () => {
    for (const line of formatStatus(await client.getStatus(datasetId))) io.out(line);
    return 0;
  });
}

/** Scores the dataset's latest snapshot against a golden set, and keeps the score with `save`. */
export async function evaluate(
  io: Io,
  client: Client,
  file: string,
  options: { save: boolean },
): Promise<number> {
  let text: string;
  try {
    text = await io.readFile(file);
  } catch (error) {
    io.err(`${file} can’t be read: ${describeError(error)}`);
    return 1;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    io.err(`${file} isn’t JSON: ${describeError(error)}`);
    return 1;
  }
  const parsed = goldenSetSchema.safeParse(json);
  if (!parsed.success) {
    io.err(`${file} isn’t a golden set:`);
    for (const issue of parsed.error.issues.slice(0, 20)) {
      io.err(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    return 1;
  }
  const golden: GoldenSet = parsed.data;
  return withApi(io, async () => {
    // The checks snapshot pull makes: a score of the wrong file would mislead.
    const pulled = await client.pullSnapshot(golden.dataset, 'latest');
    if ((await sha256Hex(pulled.body)) !== pulled.sha256) {
      io.err(
        `The snapshot’s SHA-256 doesn’t match what Spatula said (${pulled.sha256 || 'nothing'}). Nothing was scored.`,
      );
      return 1;
    }
    let data: unknown;
    try {
      data = JSON.parse(pulled.body);
    } catch {
      io.err('The snapshot isn’t JSON. Nothing was scored.');
      return 1;
    }
    const checked = snapshotSchema.safeParse(data);
    if (!checked.success || checked.data.project !== golden.dataset) {
      io.err(
        `The snapshot isn’t ${golden.dataset}’s, in the published format. Nothing was scored.`,
      );
      return 1;
    }
    if (
      checked.data.generation !== pulled.generation ||
      checked.data.snapshotId !== pulled.snapshotId
    ) {
      io.err(
        `The snapshot says generation ${checked.data.generation} (${checked.data.snapshotId}), but Spatula said generation ${pulled.generation} (${pulled.snapshotId}). Nothing was scored.`,
      );
      return 1;
    }
    const items = await client.listItems(golden.dataset);
    const scores = scoreDataset({ golden, snapshot: checked.data, items });
    for (const line of formatScores(golden, scores)) io.out(line);
    if (options.save) {
      await client.saveEval(golden.dataset, {
        generation: scores.generation,
        goldenVersion: golden.version,
        scores,
      });
      io.out('Saved the score.');
    }
    return 0;
  });
}

/** Shows the history of a dataset's scores. */
export async function evals(io: Io, client: Client, datasetId: string): Promise<number> {
  return withApi(io, async () => {
    for (const line of formatEvals(await client.listEvals(datasetId))) io.out(line);
    return 0;
  });
}

/**
 * Downloads a snapshot, and writes it only if its hash and format check out and it is the dataset
 * and generation Spatula said it was.
 */
export async function pullSnapshot(
  io: Io,
  client: Client,
  datasetId: string,
  options: { generation: number | 'latest'; out: string },
): Promise<number> {
  return withApi(io, async () => {
    const pulled = await client.pullSnapshot(datasetId, options.generation);
    const hash = await sha256Hex(pulled.body);
    if (hash !== pulled.sha256) {
      io.err(
        `The snapshot’s SHA-256 is ${hash}, but Spatula said ${pulled.sha256 || 'nothing'}. Nothing was written.`,
      );
      return 1;
    }
    let data: unknown;
    try {
      data = JSON.parse(pulled.body);
    } catch {
      io.err('The snapshot isn’t JSON. Nothing was written.');
      return 1;
    }
    const checked = snapshotSchema.safeParse(data);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      io.err(
        `The snapshot isn’t in the published format (${issue?.path.join('.')}: ${issue?.message}). Nothing was written.`,
      );
      return 1;
    }
    // A proxy or a server bug that mixes up responses must not put a mislabelled generation on disk,
    // and whoever reads the file trusts the generation inside it.
    const { project, generation, snapshotId, records } = checked.data;
    if (generation !== pulled.generation || snapshotId !== pulled.snapshotId) {
      io.err(
        `The snapshot says generation ${generation} (${snapshotId}), but Spatula said generation ${pulled.generation} (${pulled.snapshotId}). Nothing was written.`,
      );
      return 1;
    }
    // A whole response for the wrong dataset has a hash, a generation, and an ID that agree with
    // each other, so only the dataset it names gives it away.
    if (project !== datasetId) {
      io.err(
        `The snapshot is for ${project}, but you asked for ${datasetId}. Nothing was written.`,
      );
      return 1;
    }
    // A whole response for another generation than the one asked for agrees with itself too, so
    // only the request gives it away. The latest is whichever generation Spatula has.
    if (options.generation !== 'latest' && generation !== options.generation) {
      io.err(
        `You asked for generation ${options.generation}, but Spatula sent generation ${generation}. Nothing was written.`,
      );
      return 1;
    }
    try {
      await io.writeFile(options.out, pulled.body);
    } catch (error) {
      io.err(`Couldn’t write ${options.out}: ${describeError(error)}`);
      return 1;
    }
    io.out(
      `Wrote generation ${generation} of ${datasetId} (${count(records.length, 'record')}) to ${options.out}.`,
    );
    io.out(`SHA-256: ${hash}`);
    return 0;
  });
}

/** Turns the API's refusals into printed reasons and exit code 1. */
async function withApi(io: Io, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    io.err(error.message);
    for (const issue of error.issues) io.err(`  ${issue}`);
    return 1;
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
