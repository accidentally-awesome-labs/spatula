const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
};

/**
 * Normalize a URL for consistent comparison.
 * - Lowercase hostname
 * - Remove default ports (:80 for http, :443 for https)
 * - Sort query parameters
 * - Remove fragments
 * - Remove trailing slashes (except root "/")
 */
export function normalizeUrl(urlString: string): string {
  const url = new URL(urlString);

  // Lowercase hostname (URL constructor already does this, but be explicit)
  url.hostname = url.hostname.toLowerCase();

  // Remove default ports
  if (url.port === DEFAULT_PORTS[url.protocol]) {
    url.port = '';
  }

  // Sort query parameters
  const params = new URLSearchParams(url.searchParams);
  const sorted = new URLSearchParams([...params.entries()].sort());
  url.search = sorted.toString() ? `?${sorted.toString()}` : '';

  // Remove fragment
  url.hash = '';

  // Build result and remove trailing slash (but keep root "/")
  let result = url.toString();
  if (result.endsWith('/') && new URL(result).pathname !== '/') {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Compare two sets of seed URLs after normalization.
 * Returns added and removed URLs (in their original form).
 */
export function diffSeeds(
  current: string[],
  previous: string[],
): { added: string[]; removed: string[] } {
  const currentNormalized = new Map(current.map((url) => [normalizeUrl(url), url]));
  const previousNormalized = new Map(previous.map((url) => [normalizeUrl(url), url]));

  const added: string[] = [];
  const removed: string[] = [];

  for (const [norm, original] of currentNormalized) {
    if (!previousNormalized.has(norm)) {
      added.push(original);
    }
  }

  for (const [norm, original] of previousNormalized) {
    if (!currentNormalized.has(norm)) {
      removed.push(original);
    }
  }

  return { added, removed };
}
