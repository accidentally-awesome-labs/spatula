/** The local database from platform/compose.yaml. Migrating a deployment sets SPATULA_DATABASE_URL. */
export const LOCAL_DATABASE_URL = 'postgres://spatula:spatula@localhost:5434/spatula';

export function databaseUrl(): string {
  return process.env.SPATULA_DATABASE_URL || LOCAL_DATABASE_URL;
}

/** Scripts that recreate a database only touch local ones, unless told otherwise. */
export function isLocalDatabase(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}
