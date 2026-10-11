import { describe, expect, it } from 'vitest';

describe('the Workers tests’ network', () => {
  it('fails any request no handler answers, robots.txt included', async () => {
    // No handler is installed. Loopback port 9 is the discard port, where nothing listens, so
    // nothing leaves the machine even if the guard is broken. MSW's own strategies let paths that
    // look like static assets (robots.txt, .html, .json, ...) through to the network, so the
    // pipeline's first request to every host, for robots.txt, is the one that matters.
    const outcomes = await Promise.all(
      ['/robots.txt', '/products/a1'].map((path) =>
        fetch(`http://127.0.0.1:9${path}`).then(
          (response) => response.status,
          (error: unknown) => String(error),
        ),
      ),
    );

    expect(outcomes).toEqual([500, 500]);
  });
});
