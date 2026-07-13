/**
 * cors-origin.ts — CORS origin matcher for Spatula API
 *
 * Parses CORS_ALLOWED_ORIGINS into an exact-match set and single-label
 * wildcard regexes. Used by app.ts to provide the function-form `origin`
 * option to Hono's cors() middleware.
 *
 * Rules:
 * - Comma-separated list of origins, whitespace trimmed.
 * - Bare `*` is NOT allowed.
 * - Wildcard entries (containing `*`) compile to a single-label regex:
 *   `https://*.spatula.dev` → `/^https:\/\/[^./]+\.spatula\.dev$/`
 *   This matches exactly one subdomain label (no dots, no slashes).
 *   It rejects `foo.bar.spatula.dev` (two labels) and
 *   `evil.spatula.dev.attacker.com` (suffix attack).
 * - Returns `null` when the parsed list is empty or a bare `*` is present —
 *   the caller must fail boot with CORS_CONFIG_INVALID.
 */

export interface OriginMatcher {
  match(origin: string): boolean;
}

/**
 * Build an OriginMatcher from a raw comma-separated CORS_ALLOWED_ORIGINS
 * string. Returns `null` if:
 *   - The string is empty or whitespace only
 *   - Any entry is exactly `*` (bare wildcard not allowed)
 *
 * The returned matcher checks:
 *   1. Exact match against the pre-built Set
 *   2. Regex match against single-label wildcard patterns
 */
export function buildOriginMatcher(raw: string): OriginMatcher | null {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const exact = new Set<string>();
  const patterns: RegExp[] = [];

  for (const part of parts) {
    if (part.includes('*')) {
      // Reject bare wildcard.
      if (part === '*') {
        return null;
      }
      // Compile single-label wildcard regex:
      // Escape all regex metacharacters EXCEPT `*`, then replace `\*` with `[^./]+`
      // `[^./]+` matches exactly one subdomain label: one or more chars that are
      // neither a dot nor a slash. This prevents multi-label and suffix attacks.
      const escaped = part
        .replace(/[*+.?^${}()|[\]\\]/g, '\\$&') // escape ALL metacharacters INCLUDING `*`
        .replace('\\*', '[^./]+'); // replace the escaped `\*` with the label class
      patterns.push(new RegExp(`^${escaped}$`));
    } else {
      exact.add(part);
    }
  }

  return {
    match(origin: string): boolean {
      if (exact.has(origin)) return true;
      for (const pattern of patterns) {
        if (pattern.test(origin)) return true;
      }
      return false;
    },
  };
}
