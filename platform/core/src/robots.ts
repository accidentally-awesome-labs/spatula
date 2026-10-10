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

/** A Crawl-delay is a plain number of seconds: no sign, no exponent, no hexadecimal. */
const PLAIN_NUMBER = /^\d+(\.\d+)?$/u;

/**
 * Crawl-delay is capped at one day. Task 5's gate turns seconds into milliseconds, and an absurd
 * value must never become Infinity there.
 */
const MAX_CRAWL_DELAY_SECONDS = 86_400;

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
      current.agents.push(productTokenOf(value));
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
  // Merged in place: building a new array for each group would take quadratic time.
  const merged: RobotsGroup = { rules: [], crawlDelaySeconds: null, signals: {} };
  for (const { group } of chosen) {
    for (const rule of group.rules) merged.rules.push(rule);
    merged.crawlDelaySeconds = longerDelay(merged.crawlDelaySeconds, group.crawlDelaySeconds);
    for (const [name, setting] of Object.entries(group.signals)) {
      if (setting !== undefined) merged.signals[name] = mergeSignal(merged.signals[name], setting);
    }
  }
  return merged;
}

function readRule(group: RobotsGroup, key: string, value: string): void {
  if (key === 'allow' || key === 'disallow') {
    // An empty Disallow means nothing is disallowed: it adds no rule.
    if (value !== '') group.rules.push({ allow: key === 'allow', pattern: encodePath(value) });
  } else if (key === 'crawl-delay') {
    // An invalid value is ignored, never read as zero: Number('') is zero.
    if (PLAIN_NUMBER.test(value)) {
      const seconds = Math.min(Number(value), MAX_CRAWL_DELAY_SECONDS);
      group.crawlDelaySeconds = longerDelay(group.crawlDelaySeconds, seconds);
    }
  } else {
    for (const pair of value.split(',')) {
      const [name, setting] = pair.split('=').map((part) => part.trim().toLowerCase());
      if (name && (setting === 'yes' || setting === 'no')) {
        group.signals[name] = mergeSignal(group.signals[name], setting);
      }
    }
  }
}

/**
 * A User-agent line names its product token: its leading letters, underscores and hyphens,
 * or `*`.
 */
function productTokenOf(value: string): string {
  if (value.startsWith('*')) return '*';
  const [token = ''] = /^[A-Za-z_-]*/u.exec(value) ?? [];
  return token.toLowerCase();
}

/** The longer of two crawl delays. `null` means the group gave none. */
function longerDelay(earlier: number | null, later: number | null): number | null {
  if (earlier === null) return later;
  if (later === null) return earlier;
  return Math.max(earlier, later);
}

/** A "no" is sticky: a later "yes" in the same group or another never undoes it. */
function mergeSignal(earlier: 'yes' | 'no' | undefined, later: 'yes' | 'no'): 'yes' | 'no' {
  return earlier === 'no' || later === 'no' ? 'no' : 'yes';
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
  // A known slice 0 simplification, unlike RFC 9309 section 2.2.2: percent-encoded unreserved
  // characters are not decoded, and spaces are not encoded. A pattern with a character the URL
  // parser percent-encodes in paths ("<", ">", a double quote, a backtick, "{", "}") can't match
  // either, so that rule fails open: the same class of gap.
  return path
    .replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase())
    .replace(/[^\x00-\x7F]/gu, (char) => encodeURIComponent(char));
}

/** A rule's pattern against a path: `*` matches anything, and a final `$` anchors the end. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const [first = '', ...rest] = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!path.startsWith(first)) return false;
  if (rest.length === 0) return !anchored || path.length === first.length;
  // Each piece goes at its earliest position, which leaves the most room for the rest.
  const last = rest.pop() ?? '';
  let position = first.length;
  for (const part of rest) {
    const found = path.indexOf(part, position);
    if (found === -1) return false;
    position = found + part.length;
  }
  return anchored
    ? path.length - last.length >= position && path.endsWith(last)
    : path.indexOf(last, position) !== -1;
}
