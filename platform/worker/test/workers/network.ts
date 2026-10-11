import { setupNetwork } from '@msw/cloudflare';

/** Outbound requests from the Worker, answered by the handlers each test installs. */
export const network = setupNetwork();

// MSW's default lets a request that no handler answers go out to the real network, after a
// warning. Here it fails instead, so a test can never reach a real host. MSW's 'error' strategy
// exempts paths that look like static assets (robots.txt, .html, .json, ...), so a function that
// throws is used: it is applied to every request.
network.configure({
  async onUnhandledFrame({ frame }) {
    // The frame's message names the request's method and URL.
    throw new Error(
      `A Workers test made an outbound request that no handler answers: ${await frame.getUnhandledMessage()}`,
    );
  },
});
