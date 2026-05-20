/**
 * Default crawler configuration values.
 *
 * LEGAL-08: The default User-Agent identifies Spatula and includes an abuse-contact URL
 * so that site operators can reach Accidentally Awesome Labs if they observe unwanted
 * crawl traffic. This string is applied automatically when no `userAgent` option is
 * provided to a crawler.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/**
 * Build a Spatula User-Agent string for a given version.
 *
 * @param version - The semver version string (e.g. "1.2.3")
 * @returns A User-Agent string of the form: `Spatula/<version> (+https://spatula.dev/abuse)`
 *
 * @example
 * buildUserAgent('1.2.3');
 * // => 'Spatula/1.2.3 (+https://spatula.dev/abuse)'
 */
export function buildUserAgent(version: string): string {
  return `Spatula/${version} (+https://spatula.dev/abuse)`;
}

/**
 * Resolve the version from the nearest package.json at build/runtime.
 * Falls back to '0.0.0' if the package.json cannot be read.
 */
function resolvePackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../package.json',
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(pkgPath) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The default User-Agent string used by Spatula crawlers when no `userAgent` option
 * is explicitly provided. Sourced from the `@spatula/core` package version.
 *
 * Format: `Spatula/<version> (+https://spatula.dev/abuse)`
 */
export const DEFAULT_USER_AGENT: string = buildUserAgent(resolvePackageVersion());
