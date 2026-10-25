// The Worker's `Env` is generated into worker-configuration.d.ts, whose runtime types clash with
// Node's, so these tests' project doesn't load it. Modules that read variables by name, such as
// config.ts and models.ts, only need the name to exist.
interface Env {
  readonly SPATULA_VERSION: string;
  readonly PUBLIC_URL: string;
  readonly [name: string]: unknown;
}
