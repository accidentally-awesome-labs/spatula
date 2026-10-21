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
  type GoldenSet,
} from '@spatula/core';
import { packs } from '@spatula/pack-products';
import { parse, stringify } from 'yaml';
import { ApiError, type Client } from './client';
import {
  describeError,
  formatApplySummary,
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
  options: { wait: boolean; all: boolean },
): Promise<number> {
  return withApi(io, async () => {
    const { runId, existing, message } = await client.startRun(datasetId, { all: options.all });
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
 * Puts sources back (ADR 0006), then refused pages or the pages named, for the next run. A source
 * put back starts its count of blocked runs again, and a refused one is live.
 */
export async function revive(
  io: Io,
  client: Client,
  datasetId: string,
  options: { refused: boolean; pages: string[]; sources: string[] },
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
    if (!options.refused && options.pages.length === 0) return 0;
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
