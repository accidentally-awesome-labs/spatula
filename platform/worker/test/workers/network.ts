import { setupNetwork } from '@msw/cloudflare';

/** Outbound requests from the Worker, answered by the handlers each test installs. */
export const network = setupNetwork();

// MSW's default lets a request that no handler answers go out to the real network, after a
// warning. Here it fails instead, so a test can never reach a real host.
network.configure({ onUnhandledFrame: 'error' });
