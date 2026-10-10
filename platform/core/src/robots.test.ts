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
});
