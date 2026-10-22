import { parseArgs } from 'node:util';
import { createClient, type ReviewFilters } from './client';
import {
  check,
  evals,
  evaluate,
  exportTaxonomyFile,
  plan,
  pullSnapshot,
  purge,
  revive,
  review,
  run,
  seedTaxonomyFile,
  status,
  type Io,
  type ReviewRequest,
} from './commands';
import { describeError, printable } from './format';

export const USAGE = `Usage: spatula <command>

  check <definition.yaml>      Check a definition here, sending nothing
  plan <definition.yaml>       Show what applying it would change
  apply <definition.yaml>      Apply it
  run <dataset> [--wait] [--all | --backfill]
                               Start a refresh, and wait for it with --wait. A refresh
                               reads the pages that are due; --all counts every live
                               page as due, however recently it was read. The budget
                               still caps the run. --backfill only decides again, from
                               their captures, the pages a taxonomy change touched,
                               and fetches nothing
  revive <dataset> [--refused] [--irrelevant [--from-captures]] [--source <id>]... [<page>...]
                               Put refused pages, irrelevant ones, or the pages named, back
                               for the next run; --from-captures reads an irrelevant page
                               again from its capture, with no request, once its code is
                               older; --source puts a blocked or refused source back
  purge <dataset> --source <id>
                               Delete a source’s page captures, and its pages’ stored
                               copies. Its next run captures them again
  review <dataset> [--kind <kind>] [--shelf <slug>] [--source <id>] [--below <p>]
                               List the questions waiting for an answer: of a kind,
                               about pages proposed for a shelf or settled on it, from
                               a source, or proposed with less than probability p
  review <dataset> <id> <answer>
                               Answer a question with one of its answers
  review <dataset> <id> [--shelf <slug>] [--function <slug>]...
         [--feature <feature>=<value>]... [--note <text>]
                               Answer a taxonomy question in parts. A function or a
                               value left out is a no
  review <dataset> <id> --suggestion
                               Answer a question with its suggestion
  review <dataset> --answers <file.json>
                               Answer up to 500 questions at once
  review <dataset> --suggest <file.json>
                               Suggest answers, each for the question about a page
  status <dataset>             Where a dataset stands: its head, what’s held, what waits,
                               and what its consumers acknowledged
  eval <golden.json> [--save]  Score the latest snapshot against a golden set, and keep
                               the score with --save
  evals <dataset>              The history of a dataset’s scores
  snapshot pull <dataset> --out <file> [--generation <n>]
                               Download a snapshot, check its hash, and write it
  taxonomy seed <dataset> <file.yaml>
                               Seed a dataset’s taxonomy, once, from its seed file
  taxonomy export <dataset> --out <file.yaml>
                               Write the current taxonomy, with each item’s ID

Environment:
  SPATULA_URL    where Spatula is (http://localhost:8787 if unset)
  SPATULA_TOKEN  the owner token`;

/** The usage a line at a time, because a line is what a call to the Io prints. */
const USAGE_LINES = USAGE.split('\n');

const OPTIONS = {
  wait: { type: 'boolean' },
  all: { type: 'boolean' },
  backfill: { type: 'boolean' },
  refused: { type: 'boolean' },
  irrelevant: { type: 'boolean' },
  'from-captures': { type: 'boolean' },
  source: { type: 'string', multiple: true },
  save: { type: 'boolean' },
  out: { type: 'string' },
  generation: { type: 'string' },
  kind: { type: 'string' },
  shelf: { type: 'string' },
  below: { type: 'string' },
  function: { type: 'string', multiple: true },
  feature: { type: 'string', multiple: true },
  note: { type: 'string' },
  suggestion: { type: 'boolean' },
  answers: { type: 'string' },
  suggest: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const parse = (argv: string[]) =>
  parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });

const REVIEW_KINDS: readonly string[] = ['classify', 'match', 'publication'];

/**
 * What `review` was asked to do: list with filters, answer one question (with one of its answers,
 * in parts, or with its suggestion), or send a file. A call that mixes them is wrong: a string
 * says why, and null leaves it to the usage.
 */
function reviewRequest(
  values: ReturnType<typeof parse>['values'],
  reviewId: string | undefined,
  answer: string | undefined,
): ReviewRequest | string | null {
  const { kind, shelf, source, below, note, suggestion, answers, suggest } = values;
  const functions = values.function ?? [];
  const features = values.feature ?? [];
  const filtered = kind !== undefined || source !== undefined || below !== undefined;
  const inParts =
    shelf !== undefined || functions.length > 0 || features.length > 0 || note !== undefined;
  if (answers !== undefined || suggest !== undefined) {
    const alone = reviewId === undefined && !filtered && !inParts && suggestion !== true;
    if (!alone || (answers !== undefined && suggest !== undefined)) return null;
    return answers !== undefined
      ? { kind: 'answers', file: answers }
      : { kind: 'suggest', file: suggest! };
  }
  if (reviewId === undefined) {
    // Without a question, --shelf filters the list.
    if (functions.length > 0 || features.length > 0 || note !== undefined) return null;
    if (suggestion === true) return null;
    const filters: ReviewFilters = {};
    if (kind !== undefined) {
      if (!REVIEW_KINDS.includes(kind)) return '--kind is classify, match, or publication.';
      filters.kind = kind as ReviewFilters['kind'];
    }
    if (shelf !== undefined) filters.shelf = shelf;
    if (source !== undefined) {
      if (source.length !== 1) return '--source names one source to filter by.';
      filters.source = source[0];
    }
    if (below !== undefined) {
      // The API takes a probability above 0 and up to 1.
      const chance = Number(below);
      if (below.trim() === '' || !(chance > 0 && chance <= 1)) {
        return '--below is a probability from 0 to 1.';
      }
      filters.below = chance;
    }
    return { kind: 'list', filters };
  }
  if (filtered) return null;
  if (answer !== undefined) {
    return inParts || suggestion === true ? null : { kind: 'answer', reviewId, answer };
  }
  if (suggestion === true) return inParts ? null : { kind: 'suggestion', reviewId };
  if (!inParts) return null;
  const parts: { shelf?: string; functions?: string[]; features?: Record<string, string[]> } = {};
  if (shelf !== undefined) parts.shelf = shelf;
  if (functions.length > 0) parts.functions = functions;
  for (const pair of features) {
    const at = pair.indexOf('=');
    const feature = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (at < 0 || feature === '' || value === '') {
      return '--feature takes <feature>=<value>, as in --feature back=closed.';
    }
    parts.features = {
      ...parts.features,
      [feature]: [...(parts.features?.[feature] ?? []), value],
    };
  }
  // A note goes with an answer, never alone: with no parts, it would answer no to every function and
  // value offered without saying so.
  if (shelf === undefined && functions.length === 0 && features.length === 0) {
    return 'A note goes with an answer: give the parts it answers, with --shelf <slug>, --function <slug>, or --feature <feature>=<value>.';
  }
  if (note !== undefined && note.trim() === '') return '--note needs some words.';
  return { kind: 'parts', reviewId, parts, ...(note === undefined ? {} : { note: note.trim() }) };
}

/**
 * What the commands print goes through this, so no line they print can drive the terminal. A call
 * prints one line: a newline inside it is spelled out like any other control.
 */
function printableIo(io: Io): Io {
  return {
    out: (line) => io.out(printable(line)),
    err: (line) => io.err(printable(line)),
    readFile: (path) => io.readFile(path),
    writeFile: (path, data) => io.writeFile(path, data),
    sleep: (ms) => io.sleep(ms),
  };
}

/**
 * What bin.ts prints when something escapes `main`: what went wrong, on one line with its controls
 * spelled out, and never a stack trace.
 */
export function failureLine(error: unknown): string {
  return printable(`Spatula’s CLI failed: ${describeError(error)}`);
}

/** Runs one command. 0 means it worked, 1 that it didn't, and 2 that it was called wrongly. */
export async function main(
  argv: string[],
  context: { io: Io; env: Record<string, string | undefined>; fetch?: typeof fetch },
): Promise<number> {
  const { env } = context;
  const io = printableIo(context.io);
  const usage = () => {
    for (const line of USAGE_LINES) io.err(line);
    return 2;
  };
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(describeError(error));
    return usage();
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    for (const line of USAGE_LINES) io.out(line);
    return 0;
  }
  const client = createClient({
    baseUrl: env.SPATULA_URL || 'http://localhost:8787',
    token: env.SPATULA_TOKEN || undefined,
    fetch: context.fetch,
  });
  const [command, ...rest] = positionals;
  switch (command) {
    case 'check':
      return rest.length === 1 ? check(io, rest[0]!) : usage();
    case 'plan':
    case 'apply':
      return rest.length === 1
        ? plan(io, client, rest[0]!, { apply: command === 'apply' })
        : usage();
    case 'run':
      // A backfill run reads no page, so it can't count every page as due.
      return rest.length === 1 && !(values.all === true && values.backfill === true)
        ? run(io, client, rest[0]!, {
            wait: values.wait === true,
            all: values.all === true,
            backfill: values.backfill === true,
          })
        : usage();
    case 'revive': {
      const [datasetId, ...pages] = rest;
      const sources = values.source ?? [];
      if (
        datasetId === undefined ||
        (pages.length === 0 &&
          values.refused !== true &&
          values.irrelevant !== true &&
          sources.length === 0)
      ) {
        return usage();
      }
      return revive(io, client, datasetId, {
        refused: values.refused === true,
        irrelevant: values.irrelevant === true,
        fromCaptures: values['from-captures'] === true,
        pages,
        sources,
      });
    }
    case 'purge': {
      const sources = values.source ?? [];
      return rest.length === 1 && sources.length === 1
        ? purge(io, client, rest[0]!, sources[0]!)
        : usage();
    }
    case 'review': {
      const [datasetId, reviewId, answer, ...extra] = rest;
      if (datasetId === undefined || extra.length > 0) return usage();
      const request = reviewRequest(values, reviewId, answer);
      if (request === null || typeof request === 'string') {
        if (typeof request === 'string') io.err(request);
        return usage();
      }
      return review(io, client, datasetId, request);
    }
    case 'status':
      return rest.length === 1 ? status(io, client, rest[0]!) : usage();
    case 'eval':
      return rest.length === 1
        ? evaluate(io, client, rest[0]!, { save: values.save === true })
        : usage();
    case 'evals':
      return rest.length === 1 ? evals(io, client, rest[0]!) : usage();
    case 'snapshot': {
      // An empty --out names no file, as a missing one doesn't.
      if (rest[0] !== 'pull' || rest.length !== 2 || !values.out) return usage();
      const generation = values.generation === undefined ? 'latest' : Number(values.generation);
      if (generation !== 'latest' && !(Number.isInteger(generation) && generation > 0)) {
        io.err('--generation is a whole number from 1.');
        return usage();
      }
      return pullSnapshot(io, client, rest[1]!, { generation, out: values.out });
    }
    case 'taxonomy': {
      const [action, datasetId, file, ...extra] = rest;
      if (
        action === 'seed' &&
        datasetId !== undefined &&
        file !== undefined &&
        extra.length === 0
      ) {
        return seedTaxonomyFile(io, client, datasetId, file);
      }
      if (action === 'export' && datasetId !== undefined && file === undefined && values.out) {
        return exportTaxonomyFile(io, client, datasetId, values.out);
      }
      return usage();
    }
    default:
      return usage();
  }
}
