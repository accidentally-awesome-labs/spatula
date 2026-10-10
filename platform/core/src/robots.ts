/*
 * robots.txt, read as RFC 9309 says: groups of rules for user agents, matched by product token
 * without regard to case; the longest matching rule decides, and allow wins a tie. Spatula also
 * honors two lines the RFC leaves out: Crawl-delay, and Cloudflare's Content-Signal, which says
 * what a site's content may be used for.
 */

export type ContentSignals = Partial<Record<string, 'yes' | 'no'>>;

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
  signals: ContentSignals;
}

interface ParsedGroup {
  agents: string[];
  group: RobotsGroup;
}

const RULE_KEYS = new Set(['allow', 'disallow', 'crawl-delay', 'content-signal']);

/**
 * The rules that apply to a product token: every group naming it, merged, or else every `*`
 * group. `null` means no group applies, so everything is allowed.
 */
export function parseRobots(text: string, productToken: string): RobotsGroup | null {
  const groups: ParsedGroup[] = [];
  let current: ParsedGroup | null = null;
  let readingAgents = false;
  for (const rawLine of text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim();
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (current === null || !readingAgents) {
        current = { agents: [], group: { rules: [], crawlDelaySeconds: null, signals: {} } };
        groups.push(current);
        readingAgents = true;
      }
      current.agents.push((value.split('/')[0] ?? '').trim().toLowerCase());
      continue;
    }
    // Other records, such as Sitemap, belong to no group and don't end one.
    if (current === null || !RULE_KEYS.has(key)) continue;
    readingAgents = false;
    readRule(current.group, key, value);
  }

  const token = productToken.toLowerCase();
  const named = groups.filter((parsed) => parsed.agents.includes(token));
  const chosen = named.length > 0 ? named : groups.filter((parsed) => parsed.agents.includes('*'));
  if (chosen.length === 0) return null;
  return chosen.reduce<RobotsGroup>(
    (merged, { group }) => ({
      rules: [...merged.rules, ...group.rules],
      crawlDelaySeconds: merged.crawlDelaySeconds ?? group.crawlDelaySeconds,
      signals: { ...group.signals, ...merged.signals },
    }),
    { rules: [], crawlDelaySeconds: null, signals: {} },
  );
}

function readRule(group: RobotsGroup, key: string, value: string): void {
  if (key === 'allow' || key === 'disallow') {
    // An empty Disallow means nothing is disallowed: it adds no rule.
    if (value !== '') group.rules.push({ allow: key === 'allow', pattern: encodePath(value) });
  } else if (key === 'crawl-delay') {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) group.crawlDelaySeconds ??= seconds;
  } else {
    for (const pair of value.split(',')) {
      const [name, setting] = pair.split('=').map((part) => part.trim().toLowerCase());
      if (name && (setting === 'yes' || setting === 'no')) group.signals[name] = setting;
    }
  }
}

/** Whether the group lets Spatula fetch a URL. robots.txt itself is always allowed. */
export function isAllowed(group: RobotsGroup | null, url: URL): boolean {
  if (group === null || url.pathname === '/robots.txt') return true;
  const path = encodePath(url.pathname + url.search);
  let decisive: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!matches(rule.pattern, path)) continue;
    if (
      decisive === null ||
      rule.pattern.length > decisive.pattern.length ||
      (rule.pattern.length === decisive.pattern.length && rule.allow)
    ) {
      decisive = rule;
    }
  }
  return decisive === null || decisive.allow;
}

/** Paths compare percent-encoded: non-ASCII characters encoded, escapes in uppercase. */
function encodePath(path: string): string {
  // Known slice 0 simplification: this does not decode percent-encoded unreserved characters or encode spaces, as RFC 9309 section 2.2.2 describes.
  return path
    .replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase())
    .replace(/[^\x00-\x7F]/gu, (char) => encodeURIComponent(char));
}

/** A rule's pattern against a path: `*` matches anything, and a final `$` anchors the end. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}
