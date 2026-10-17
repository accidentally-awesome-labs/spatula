import {
  packIssues,
  parseDefinition,
  RUN_SLOT_TAKEN,
  sha256Hex,
  snapshotSchema,
  type Definition,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import { parse } from 'yaml';
import { ApiError, type Client } from './client';
import {
  describeError,
  formatApplySummary,
  formatReviews,
  formatRun,
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
  options: { wait: boolean; all: boolean },
): Promise<number> {
  return withApi(io, async () => {
    const { runId, existing, message } = await client.startRun(datasetId, { all: options.all });
    // The API names a run of an earlier slot that is still going in its own words. The slot's
    // sentence is the CLI's, with the run's ID, for the run this one repeats.
    io.out(
      !existing
        ? `Started ${runId}.`
        : message === null || message === RUN_SLOT_TAKEN
          ? `A run already started in this five-minute slot: ${runId}.`
          : message,
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

/** Puts refused pages, or the pages named, back for the next run. */
export async function revive(
  io: Io,
  client: Client,
  datasetId: string,
  options: { refused: boolean; pages: string[] },
): Promise<number> {
  return withApi(io, async () => {
    const { revived } = await client.reviveItems(datasetId, {
      ...(options.refused ? { refused: true as const } : {}),
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

/** Lists the dataset's open questions, or answers one. */
export async function review(
  io: Io,
  client: Client,
  datasetId: string,
  answering: { reviewId: string; answer: string } | null,
): Promise<number> {
  return withApi(io, async () => {
    if (answering === null) {
      const reviews = await client.listReviews(datasetId);
      for (const line of formatReviews(datasetId, reviews)) io.out(line);
      return 0;
    }
    const { effect } = await client.answerReview(datasetId, answering.reviewId, answering.answer);
    io.out(
      `Answered ${answering.reviewId}: ${answering.answer}.${effect === '' ? '' : ` ${effect}`}`,
    );
    return 0;
  });
}

/** Says where a dataset stands. */
export async function status(io: Io, client: Client, datasetId: string): Promise<number> {
  return withApi(io, async () => {
    for (const line of formatStatus(await client.getStatus(datasetId))) io.out(line);
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
