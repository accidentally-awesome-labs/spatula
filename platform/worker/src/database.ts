import { createDatabase, type Executor } from '@spatula/store';

/**
 * Runs `fn` with a database client, then closes it. A Worker can't keep connections between
 * requests or Workflow steps, so each use opens a small client; Hyperdrive keeps the real
 * connections to Postgres open between them.
 */
export async function withDatabase<T>(env: Env, fn: (db: Executor) => Promise<T>): Promise<T> {
  const { db, close } = createDatabase(env.HYPERDRIVE.connectionString, { max: 1 });
  try {
    return await fn(db);
  } finally {
    await close();
  }
}
