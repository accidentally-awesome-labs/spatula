import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RobotsTxtChecker } from '../../../src/crawlers/robots-txt.js';

describe('RobotsTxtChecker', () => {
  let checker: RobotsTxtChecker;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    checker = new RobotsTxtChecker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows URL when no robots.txt exists (404)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const allowed = await checker.isAllowed('https://example.com/page');
    expect(allowed).toBe(true);
  });

  it('blocks URL disallowed by robots.txt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow: /private/'),
    });
    const allowed = await checker.isAllowed('https://example.com/private/secret');
    expect(allowed).toBe(false);
  });

  it('allows URL not disallowed by robots.txt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow: /private/'),
    });
    const allowed = await checker.isAllowed('https://example.com/public/page');
    expect(allowed).toBe(true);
  });

  it('caches robots.txt per domain (does not refetch)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page1');
    await checker.isAllowed('https://example.com/page2');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches separately for different domains', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://a.com/page');
    await checker.isAllowed('https://b.com/page');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses SpatulaBot as default user agent', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve('User-agent: SpatulaBot\nDisallow: /blocked/\n\nUser-agent: *\nDisallow:'),
    });
    const allowed = await checker.isAllowed('https://example.com/blocked/page');
    expect(allowed).toBe(false);
  });

  it('returns Crawl-Delay if specified', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nCrawl-delay: 5\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page');
    const delay = checker.getCrawlDelay('https://example.com');
    expect(delay).toBe(5);
  });

  it('returns null for Crawl-Delay when not specified', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page');
    const delay = checker.getCrawlDelay('https://example.com');
    expect(delay).toBeNull();
  });

  it('refetches robots.txt after 1-hour TTL expires', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });
    await checker.isAllowed('https://example.com/page1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past 1-hour TTL
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    await checker.isAllowed('https://example.com/page2');
    expect(mockFetch).toHaveBeenCalledTimes(2); // refetched
    vi.useRealTimers();
  });

  it('handles fetch errors gracefully (allows crawl)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const allowed = await checker.isAllowed('https://example.com/page');
    expect(allowed).toBe(true); // fail open — don't block on robots.txt errors
  });

  it('deduplicates concurrent fetches for the same domain (thundering herd)', async () => {
    let resolveResponse: (v: unknown) => void;
    const slowResponse = new Promise((resolve) => {
      resolveResponse = resolve;
    });

    mockFetch.mockReturnValue(slowResponse);

    // Fire three concurrent requests for the same domain
    const p1 = checker.isAllowed('https://example.com/page1');
    const p2 = checker.isAllowed('https://example.com/page2');
    const p3 = checker.isAllowed('https://example.com/page3');

    // Resolve the single in-flight fetch
    resolveResponse!({
      ok: true,
      text: () => Promise.resolve('User-agent: *\nDisallow:'),
    });

    await Promise.all([p1, p2, p3]);

    // Despite 3 concurrent calls, only 1 HTTP fetch was made
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
