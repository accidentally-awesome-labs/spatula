import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Per-route rate-limit configuration loader.
 *
 * Spec: 16-CONTEXT.md "Claude's Discretion" / 16-RESEARCH.md § Code Examples.
 * Shape is frozen at v1; values are operator-tunable via `config/rate-limits.yaml`
 * with `SPATULA_RATE_LIMITS_PATH` overlay (file fully replaces — no merging).
 *
 * Lookup is exact-match `METHOD /api/v1/...` against `routeGroups`; unmatched
 * routes fall back to `default`. No globs in v1.
 */

const rateLimitEntrySchema = z.object({
  requestsPerMinute: z.number().int().positive(),
  maxConcurrentJobs: z.number().int().positive().optional(),
});

const rateLimitsFileSchema = z.object({
  default: rateLimitEntrySchema,
  routeGroups: z.record(z.string(), rateLimitEntrySchema).default({}),
});

export type RateLimitConfig = z.infer<typeof rateLimitEntrySchema>;
type RateLimitsFile = z.infer<typeof rateLimitsFileSchema>;

let cache: RateLimitsFile | null = null;

/**
 * Resolves the rate-limits YAML path:
 *   1. `SPATULA_RATE_LIMITS_PATH` env var (highest priority, exact path).
 *   2. `./config/rate-limits.yaml` from the current working directory.
 *   3. Walk up parents until a `config/rate-limits.yaml` is found.
 *   4. Fall back to the relative path (will throw on read for a clean error
 *      message at boot).
 *
 * Step 3 makes the loader robust to running from monorepo sub-packages
 * (e.g., vitest from `apps/api/`) where cwd != repo root.
 */
function resolveConfigPath(): string {
  if (process.env.SPATULA_RATE_LIMITS_PATH) {
    return resolve(process.env.SPATULA_RATE_LIMITS_PATH);
  }
  const cwdCandidate = resolve('./config/rate-limits.yaml');
  if (existsSync(cwdCandidate)) return cwdCandidate;

  // Walk up looking for `config/rate-limits.yaml`
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, 'config/rate-limits.yaml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwdCandidate;
}

/**
 * Loads the per-route rate-limit configuration. Caches the parsed file in
 * memory for the lifetime of the process; subsequent calls return the cached
 * value without re-reading disk. Fail-loud at boot if the YAML is malformed.
 */
export function loadRateLimitsConfig(): RateLimitsFile {
  if (cache) return cache;
  const path = resolveConfigPath();
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  cache = rateLimitsFileSchema.parse(parsed);
  return cache;
}

/**
 * Returns the rate-limit config for `${method.toUpperCase()} ${routePath}`,
 * falling back to `default` when no exact-match route-group entry exists.
 *
 * `routePath` should be the matched Hono route template (e.g., `/api/v1/jobs/:id`),
 * NOT the request URL — the middleware passes `c.req.routePath ?? c.req.path`.
 */
export function lookupRateLimit(method: string, routePath: string): RateLimitConfig {
  const cfg = loadRateLimitsConfig();
  const key = `${method.toUpperCase()} ${routePath}`;
  return cfg.routeGroups[key] ?? cfg.default;
}

/**
 * Test-only — clears the loader cache so a fresh `SPATULA_RATE_LIMITS_PATH`
 * env override can be picked up. Production code never calls this.
 */
export function _resetRateLimitsCacheForTests(): void {
  cache = null;
}
