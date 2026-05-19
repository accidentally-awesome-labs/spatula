/**
 * `client.experimental.*` namespace scaffolding.
 *
 * Spatula v1.0 ships ZERO experimental surfaces. The first surface
 * (forensic-extractions admin endpoint) lands in Phase 18 per
 * `docs/deprecation-policy.md`. Until then, any property access on
 * `client.experimental` throws — making accidental dependence on a
 * yet-unimplemented surface fail loudly at use-site.
 */
export function createExperimentalNamespace(): Record<string, never> {
  return new Proxy({} as Record<string, never>, {
    get(_target, prop) {
      // Ignore well-known symbols/properties accessed by the JS runtime so the
      // namespace can be inspected and serialized without exploding. The
      // intent is to fail on attempted use, not on debug introspection.
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'toJSON' || prop === 'constructor') return undefined;
      throw new Error(
        `client.experimental.${String(prop)} is not available — Spatula v1.0 ships with zero experimental surfaces. ` +
          `See docs/deprecation-policy.md. First experimental surface (forensic-extractions admin endpoint) lands in Phase 18.`,
      );
    },
  });
}
