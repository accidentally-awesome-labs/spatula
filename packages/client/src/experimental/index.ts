/**
 * `client.experimental.*` namespace scaffolding — Plan 18-05 Task 3 (SEC-05)
 *
 * Spatula v1.0 ships ONE experimental surface: `forensic` (the forensic-
 * extractions admin endpoint). Future experimentals are governed by
 * docs/deprecation-policy.md (6-month max lifetime).
 *
 * The Proxy is fail-loud for any unknown property:
 *   - `.forensic` → real `ForensicSurface` object
 *   - `.then`, `.toJSON`, `.constructor`, symbols → `undefined` (debug introspection)
 *   - Anything else → throws with an explanatory message
 *
 * This design ensures accidental dependence on future (not-yet-shipped)
 * experimental surfaces fails loudly at the use-site rather than silently.
 */
import { createForensicSurface } from './forensic.js';
import type { ForensicTransport } from './forensic.js';

// Well-known JS runtime properties that introspect an object — return undefined
// so that `await client.experimental` and `JSON.stringify(client.experimental)`
// work without exploding.
const WELL_KNOWN_PROPS = new Set(['then', 'toJSON', 'constructor']);

/**
 * The type of the experimental namespace as seen by TypeScript callers.
 * Lists all live experimental surfaces so TS consumers get proper type checking.
 */
export interface ExperimentalNamespace {
  /** Forensic extraction admin surface (SEC-05, Plan 18-05). */
  forensic: ReturnType<typeof createForensicSurface>;
}

/**
 * Create the `experimental` namespace Proxy.
 *
 * @param transport - The `SpatulaClient` transport (structural: must implement request + baseUrl).
 */
export function createExperimentalNamespace(transport: ForensicTransport): ExperimentalNamespace {
  // Lazily initialize the forensic surface so it's created once on first access.
  let forensicSurface: ReturnType<typeof createForensicSurface> | undefined;

  return new Proxy({} as ExperimentalNamespace, {
    get(_target, prop) {
      // Symbols (Symbol.toPrimitive, Symbol.iterator, etc.) → undefined
      if (typeof prop === 'symbol') return undefined;

      // Well-known JS runtime props → undefined
      if (WELL_KNOWN_PROPS.has(prop as string)) return undefined;

      // `forensic` → the real forensic surface (lazily initialized)
      if (prop === 'forensic') {
        if (!forensicSurface) {
          forensicSurface = createForensicSurface(transport);
        }
        return forensicSurface;
      }

      // All other props → fail-loud
      throw new Error(
        `client.experimental.${String(prop)} is not available — ` +
          `Spatula v1.0 ships with exactly ONE experimental surface (forensic, Phase 18). ` +
          `See docs/deprecation-policy.md for the experimental surface policy.`,
      );
    },
  });
}
