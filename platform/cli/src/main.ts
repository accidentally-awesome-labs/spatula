import { parseArgs } from 'node:util';
import { createClient } from './client';
import { check, plan, pullSnapshot, run, type Io } from './commands';

export const USAGE = `Usage: spatula <command>

  check <definition.yaml>      Check a definition here, sending nothing
  plan <definition.yaml>       Show what applying it would change
  apply <definition.yaml>      Apply it
  run <dataset> [--wait]       Start a refresh, and wait for it with --wait
  snapshot pull <dataset> --out <file> [--generation <n>]
                               Download a snapshot, check its hash, and write it

Environment:
  SPATULA_URL    where Spatula is (http://localhost:8787 if unset)
  SPATULA_TOKEN  the owner token`;

const OPTIONS = {
  wait: { type: 'boolean' },
  out: { type: 'string' },
  generation: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const parse = (argv: string[]) =>
  parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });

/** Runs one command. 0 means it worked, 1 that it didn't, and 2 that it was called wrongly. */
export async function main(
  argv: string[],
  context: { io: Io; env: Record<string, string | undefined>; fetch?: typeof fetch },
): Promise<number> {
  const { io, env } = context;
  const usage = () => {
    io.err(USAGE);
    return 2;
  };
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return usage();
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    io.out(USAGE);
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
        ? run(io, client, rest[0]!, { wait: values.wait === true })
        : usage();
    case 'snapshot': {
      if (rest[0] !== 'pull' || rest.length !== 2 || values.out === undefined) return usage();
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
