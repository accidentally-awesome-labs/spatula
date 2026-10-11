import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from './robots';

const allowed = (robots: string, path: string) =>
  isAllowed(parseRobots(robots, 'Spatula'), new URL(`https://maker.example${path}`));

describe('parseRobots and isAllowed', () => {
  it('uses the group for Spatula when there is one, ignoring case and versions', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /private',
      '',
      'USER-AGENT: spatula/0.2',
      'Disallow: /spatula-only',
    ].join('\n');
    expect(allowed(robots, '/private/page')).toBe(true);
    expect(allowed(robots, '/spatula-only/page')).toBe(false);
  });

  it('falls back to the * group, and allows everything without one', () => {
    expect(allowed('User-agent: *\nDisallow: /cart', '/cart')).toBe(false);
    expect(allowed('User-agent: OtherBot\nDisallow: /', '/products/a')).toBe(true);
    expect(allowed('', '/products/a')).toBe(true);
  });

  it('lets the longest matching rule decide, and allow win a tie', () => {
    expect(allowed('User-agent: *\nDisallow: /\nAllow: /products', '/products/a')).toBe(true);
    expect(allowed('User-agent: *\nDisallow: /\nAllow: /products', '/cart')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /folder\nAllow: /folder', '/folder/page')).toBe(true);
  });

  it('matches * anywhere, $ at the end, and the query string', () => {
    const robots = 'User-agent: *\nDisallow: /*.gif$\nDisallow: /*?sort=';
    expect(allowed(robots, '/a/b.gif')).toBe(false);
    expect(allowed(robots, '/a/b.gif?size=2')).toBe(true);
    expect(allowed(robots, '/products?sort=price')).toBe(false);
  });

  it('ignores an empty Disallow, and always allows robots.txt itself', () => {
    expect(allowed('User-agent: *\nDisallow:', '/anything')).toBe(true);
    expect(allowed('User-agent: *\nDisallow: /', '/robots.txt')).toBe(true);
  });

  it('compares paths percent-encoded', () => {
    expect(allowed('User-agent: *\nDisallow: /café', '/caf%C3%A9/menu')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /a%2fb', '/a%2Fb')).toBe(false);
  });

  it('merges groups for the same agent and skips comments, a BOM, and rules before any agent', () => {
    const robots = [
      '\uFEFFDisallow: /before-any-agent',
      'User-agent: Spatula # us',
      'Disallow: /one',
      'User-agent: *',
      'Disallow: /all',
      'User-agent: Spatula',
      'Disallow: /two',
    ].join('\r\n');
    const group = parseRobots(robots, 'Spatula');
    expect(group?.rules.map((rule) => rule.pattern)).toEqual(['/one', '/two']);
    expect(allowed(robots, '/before-any-agent')).toBe(true);
    expect(allowed(robots, '/all')).toBe(true);
  });

  it('reads Crawl-delay and Content-Signal from the group that applies', () => {
    const robots =
      'User-agent: *\nContent-Signal: search=yes, ai-train=no\nCrawl-delay: 2.5\nAllow: /';
    expect(parseRobots(robots, 'Spatula')).toEqual({
      rules: [{ allow: true, pattern: '/' }],
      crawlDelaySeconds: 2.5,
      signals: { search: 'yes', 'ai-train': 'no' },
    });
  });

  it('keeps user-agent lines separated by other records in one group', () => {
    const robots =
      'User-agent: A\nSitemap: https://maker.example/sitemap.xml\nUser-agent: Spatula\nDisallow: /x';
    expect(parseRobots(robots, 'Spatula')?.rules).toEqual([{ allow: false, pattern: '/x' }]);
    expect(parseRobots(robots, 'A')?.rules).toEqual([{ allow: false, pattern: '/x' }]);
  });

  it('matches a rule with about 40 wildcards in linear time', () => {
    const robots = `User-agent: *\nDisallow: /${'*a'.repeat(40)}*b`;
    expect(allowed(robots, `/${'a'.repeat(3000)}`)).toBe(true);
    expect(allowed(robots, `/${'a'.repeat(3000)}b`)).toBe(false);
  });

  it('lets a "no" win over a later "yes" in the same group', () => {
    const later = 'User-agent: *\nContent-Signal: ai-input=no\nContent-Signal: ai-input=yes';
    const inline = 'User-agent: *\nContent-Signal: ai-input=no, ai-input=yes';
    expect(parseRobots(later, 'Spatula')?.signals).toEqual({ 'ai-input': 'no' });
    expect(parseRobots(inline, 'Spatula')?.signals).toEqual({ 'ai-input': 'no' });
  });

  it('lets a "no" in one chosen group win over a "yes" in another', () => {
    const yesFirst =
      'User-agent: Spatula\nContent-Signal: ai-train=yes\n\nUser-agent: Spatula\nContent-Signal: ai-train=no';
    const noFirst =
      'User-agent: Spatula\nContent-Signal: ai-train=no\n\nUser-agent: Spatula\nContent-Signal: ai-train=yes';
    expect(parseRobots(yesFirst, 'Spatula')?.signals).toEqual({ 'ai-train': 'no' });
    expect(parseRobots(noFirst, 'Spatula')?.signals).toEqual({ 'ai-train': 'no' });
  });

  it('takes the largest valid Crawl-delay, ignoring an empty line before it', () => {
    const empty = 'User-agent: *\nCrawl-delay:\nCrawl-delay: 10';
    const twoGroups = 'User-agent: Spatula\nCrawl-delay: 3\n\nUser-agent: Spatula\nCrawl-delay: 10';
    expect(parseRobots(empty, 'Spatula')?.crawlDelaySeconds).toBe(10);
    expect(parseRobots(twoGroups, 'Spatula')?.crawlDelaySeconds).toBe(10);
  });

  it('ignores a Crawl-delay that is not a plain number of seconds', () => {
    for (const value of ['', 'abc', '-1', '0x10', '1e3', '1e308']) {
      const robots = `User-agent: *\nCrawl-delay: ${value}`;
      expect(parseRobots(robots, 'Spatula')?.crawlDelaySeconds).toBeNull();
    }
  });

  it('caps a Crawl-delay at one day', () => {
    const robots = 'User-agent: *\nCrawl-delay: 100000';
    expect(parseRobots(robots, 'Spatula')?.crawlDelaySeconds).toBe(86400);
  });

  it('reads a product token as its leading letters, so trailing text still names Spatula', () => {
    for (const agent of ['Spatula Bot', 'Spatula/0.2', 'Spatula;']) {
      expect(allowed(`User-agent: ${agent}\nDisallow: /x`, '/x')).toBe(false);
    }
    expect(allowed('User-agent: Spatula-Bot\nDisallow: /x', '/x')).toBe(true);
  });

  it('strips a comment that holds a line separator, so the rule before it still counts', () => {
    // Lines end only at CR and LF, so a comment can hold U+2028, which a pattern's "." never
    // matches.
    const robots = 'User-agent: *\nDisallow: /private # keep\u{2028}out';
    expect(parseRobots(robots, 'Spatula')?.rules).toEqual([{ allow: false, pattern: '/private' }]);
    expect(allowed(robots, '/private')).toBe(false);
  });

  it('strips a long comment in linear time', { timeout: 30_000 }, () => {
    const robots = `User-agent: *\nDisallow: /x ${'#'.repeat(200_000)}\u{2028}`;
    const started = performance.now();
    const group = parseRobots(robots, 'Spatula');
    const elapsed = performance.now() - started;
    expect(group?.rules).toEqual([{ allow: false, pattern: '/x' }]);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('drops a Content-Signal whose name is a NUL', () => {
    const robots = 'User-agent: *\nContent-Signal: \u{0}=yes, ai-input=no';
    expect(parseRobots(robots, 'Spatula')?.signals).toEqual({ 'ai-input': 'no' });
  });

  it('keeps only the signals the Content Signals Policy names, among 50,000 others', () => {
    const names = Array.from({ length: 50_000 }, (_, i) => `n${i}=yes`).join(', ');
    const robots = `User-agent: *\nContent-Signal: ${names}, ai-train=no`;
    const signals = parseRobots(robots, 'Spatula')?.signals ?? {};
    expect(Object.keys(signals)).toHaveLength(1);
    expect(signals).toEqual({ 'ai-train': 'no' });
  });

  it('reads a signal’s name without regard to case, and keeps it in lowercase', () => {
    const robots = 'User-agent: *\nContent-Signal: AI-Input=no';
    expect(parseRobots(robots, 'Spatula')?.signals).toEqual({ 'ai-input': 'no' });
  });
});
