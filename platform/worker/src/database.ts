import { createDatabase, type Executor } from '@spatula/store';

/**
 * Runs `fn` with a database client. A Worker can't keep connections between requests or Workflow
 * steps, so each use opens a small client; Hyperdrive keeps the real connections to Postgres open
 * between them. The client is never ended: its socket closes when the invocation does, as in
 * Cloudflare's examples, and ending it here makes postgres.js's Workers build reject a read it
 * left pending ("This socket has been closed.").
 */
export async function withDatabase<T>(env: Env, fn: (db: Executor) => Promise<T>): Promise<T> {
  const { db } = createDatabase(env.HYPERDRIVE.connectionString, { max: 1 });
  return fn(db);
}
