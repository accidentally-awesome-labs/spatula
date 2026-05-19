/**
 * Single Ajv2020 instance factory shared across the contract suite.
 *
 * Pitfall #1 (16-RESEARCH.md "Common Pitfalls"): Ajv's default export does NOT
 * support OpenAPI 3.1 / JSON Schema 2020-12. Importing via the bare specifier
 *
 *     import Ajv from 'ajv'
 *
 * silently uses the draft-07 validator, which mis-validates the `nullable: true`
 * and tuple-form `prefixItems: [...]` keywords used by zod-openapi-emitted
 * schemas. Always import via the `2020` sub-path.
 *
 * `strict: false` permits unknown OpenAPI keywords (e.g., `example`, `summary`,
 * `description`) to flow through without throwing. `allErrors: true` produces
 * multi-error reports so a single failing tuple surfaces every shape mismatch
 * (not just the first one).
 *
 * The same setup is mirrored on the server side by the dev-only
 * `validateExamplesAtBoot()` in apps/api/src/openapi-config.ts (plan 16-3) so
 * spec drift caught at boot is byte-identical to spec drift caught in CI.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}
