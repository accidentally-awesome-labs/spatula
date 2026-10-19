import { parseArgs } from 'node:util';
import { createClient } from './client';
import {
  check,
  evals,
  evaluate,
  plan,
  pullSnapshot,
  revive,
  review,
  run,
  status,
  type Io,
} from './commands';
import { describeError, printable } from './format';

export const USAGE = `Usage: spatula <command>

  check <definition.yaml>      Check a definition here, sending nothing
  plan <definition.yaml>       Show what applying it would change
  apply <definition.yaml>      Apply it
  run <dataset> [--wait] [--all]
                               Start a refresh, and wait for it with --wait. A refresh
                               reads the pages that are due; --all counts every live
                               page as due, however recently it was read. The budget
                               still caps the run
  revive <dataset> [--refused] [--source <id>]... [<page>...]
                               Put refused pages, or the pages named, back for the next
                               run; --source puts a blocked or refused source back
  review <dataset> [<id> <answer>]
                               List the questions waiting for an answer, or answer one
  status <dataset>             Where a dataset stands: its head, what’s held, what waits,
                               and what its consumers acknowledged
  eval <golden.json> [--save]  Score the latest snapshot against a golden set, and keep
                               the score with --save
  evals <dataset>              The history of a dataset’s scores
  snapshot pull <dataset> --out <file> [--generation <n>]
                               Download a snapshot, check its hash, and write it

Environment:
  SPATULA_URL    where Spatula is (http://localhost:8787 if unset)
  SPATULA_TOKEN  the owner token`;

/** The usage a line at a time, because a line is what a call to the Io prints. */
const USAGE_LINES = USAGE.split('\n');

const OPTIONS = {
  wait: { type: 'boolean' },
  all: { type: 'boolean' },
  refused: { type: 'boolean' },
  source: { type: 'string', multiple: true },
  save: { type: 'boolean' },
  out: { type: 'string' },
  generation: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const parse = (argv: string[]) =>
  parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });

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
      return rest.length === 1
        ? run(io, client, rest[0]!, { wait: values.wait === true, all: values.all === true })
        : usage();
    case 'revive': {
      const [datasetId, ...pages] = rest;
      const sources = values.source ?? [];
      if (
        datasetId === undefined ||
        (pages.length === 0 && values.refused !== true && sources.length === 0)
      ) {
        return usage();
      }
      return revive(io, client, datasetId, {
        refused: values.refused === true,
        pages,
        sources,
      });
    }
    case 'review': {
      const [datasetId, reviewId, answer, ...extra] = rest;
      if (
        datasetId === undefined ||
        extra.length > 0 ||
        (reviewId !== undefined) !== (answer !== undefined)
      ) {
        return usage();
      }
      return review(
        io,
        client,
        datasetId,
        reviewId === undefined ? null : { reviewId, answer: answer! },
      );
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
    default:
      return usage();
  }
}
