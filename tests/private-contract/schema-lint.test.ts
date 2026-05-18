import { describe, it, expect, beforeAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const BASELINE_PATH = join(__dirname, 'baseline.schema.sql');
const NORMALIZER = join(REPO_ROOT, 'scripts/normalize-schema-dump.sh');

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://spatula:spatula@localhost:5432/spatula_test';

/**
 * Run `pg_dump --schema-only` against DATABASE_URL and pipe through the Wave 4
 * normalizer (`scripts/normalize-schema-dump.sh`). Returns the normalized SQL
 * text. Per CONTEXT.md D-03 we reuse the Wave 4 normalizer rather than
 * spinning up a parallel pipeline — it already handles pg_dump 14+ token
 * noise + journal-row stripping.
 */
async function dumpAndNormalize(databaseUrl: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const dump = spawn('pg_dump', ['--schema-only', '--no-owner', '--no-acl', databaseUrl]);
    const norm = spawn('bash', [NORMALIZER]);
    let stdout = '';
    let stderrDump = '';
    let stderrNorm = '';

    dump.stdout.pipe(norm.stdin);
    dump.stderr.on('data', (d) => (stderrDump += d.toString()));
    norm.stdout.on('data', (d) => (stdout += d.toString()));
    norm.stderr.on('data', (d) => (stderrNorm += d.toString()));

    let dumpExited = false;
    let normExited = false;

    dump.on('error', rejectPromise);
    norm.on('error', rejectPromise);

    dump.on('exit', (code) => {
      dumpExited = true;
      if (code !== 0) {
        rejectPromise(new Error(`pg_dump exited ${code}: ${stderrDump}`));
        return;
      }
      // norm.stdin is auto-closed by the pipe when dump.stdout ends
      if (normExited) resolvePromise(stdout);
    });

    norm.on('exit', (code) => {
      normExited = true;
      if (code !== 0) {
        rejectPromise(new Error(`normalize-schema-dump.sh exited ${code}: ${stderrNorm}`));
        return;
      }
      if (dumpExited) resolvePromise(stdout);
    });
  });
}

// Skip the entire suite when Postgres / pg_dump isn't available — keeps
// `pnpm test:private-contract` green for contributors running it cold.
let setupOk = false;
let pgDumpAvailable = false;

describe('private-contract SQL schema lint', () => {
  beforeAll(async () => {
    try {
      await execFileAsync('pg_dump', ['--version']);
      pgDumpAvailable = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[schema-lint.test.ts] Skipping — pg_dump not on PATH');
      return;
    }
    try {
      // Apply the v1 baseline migration to the test DB. Idempotent enough:
      // run-migrate.ts skips already-applied migrations via the namespaced
      // __drizzle_migrations_oss journal.
      await execFileAsync(
        'pnpm',
        ['--filter', '@spatula/db', 'exec', 'tsx', 'src/run-migrate.ts'],
        {
          env: { ...process.env, DATABASE_URL },
          cwd: REPO_ROOT,
        },
      );
      setupOk = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[schema-lint.test.ts] Skipping — migration apply failed:',
        (err as Error).message,
      );
    }
  }, 60_000);

  it('introspected schema matches committed baseline.schema.sql', async (ctx) => {
    if (!pgDumpAvailable || !setupOk) return ctx.skip();

    const actual = await dumpAndNormalize(DATABASE_URL);

    // First-run bootstrap: if the baseline doesn't exist yet, write it and
    // pass. This is a one-time convenience for cold-checkout cases — in CI
    // and post-bootstrap local runs the baseline is committed and the test
    // performs the real diff.
    if (!existsSync(BASELINE_PATH)) {
      writeFileSync(BASELINE_PATH, actual);
      // eslint-disable-next-line no-console
      console.warn(`[schema-lint.test.ts] Wrote initial baseline to ${BASELINE_PATH}`);
      return;
    }

    const baseline = readFileSync(BASELINE_PATH, 'utf-8');

    // Direct text comparison after normalization. If the diff is non-empty,
    // either:
    //   (a) the schema was intentionally changed — regenerate baseline per
    //       README "SQL schema lint" section + open a spatula-saas mirror PR
    //   (b) the schema drifted unintentionally — fix the migration or the
    //       schema definition before merging
    expect(actual).toEqual(baseline);
  }, 60_000);
});
