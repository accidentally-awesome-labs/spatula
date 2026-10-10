import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * A Drizzle client over postgres.js. In Workers, pass Hyperdrive's connection string and open one
 * client per request or Workflow step; Hyperdrive pools the real connections.
 */
export function createDatabase(url: string, { max = 5 }: { max?: number } = {}) {
  const client = postgres(url, { max, fetch_types: false, onnotice: () => {} });
  // Drizzle parses json itself, so postgres.js must not: "508823" would come back as a number.
  client.options.parsers[114] = client.options.parsers[3802] = (value: string) => value;
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

export type Database = ReturnType<typeof createDatabase>['db'];

/** The client or a transaction inside it: anything that runs queries. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
