import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Worker's tests run in workerd, with its real bindings: Hyperdrive points at the test database
// global-setup.ts rebuilds and names; R2, the Durable Object, and the Workflow run in Miniflare.
export default defineConfig({
  test: {
    // Outside the project below on purpose. The plugin makes Vite resolve packages the way workerd
    // does, so a global setup inside the project would load postgres.js's Workers build into Node,
    // where `cloudflare:sockets` doesn't exist. Projects inherit what the root provides.
    globalSetup: ['test/workers/global-setup.ts'],
    projects: [
      {
        // The plugin has Vite process every dependency, and Vite warns about the packages that
        // publish a sourcemap without its sources (the Anthropic SDK's standardwebhooks does).
        logLevel: 'error',
        plugins: [
          cloudflareTest(({ inject }) => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              hyperdrives: { HYPERDRIVE: inject('databaseUrl') },
              bindings: {
                // The Worker reads an empty secret as unset, so a key the owner later puts in
                // .dev.vars can't make these tests call a paid model, sign their requests, give
                // crowdio a token, a key, or scopes (.dev.vars.example lists crowdio's three), or
                // open the console. The tests that need them set them on bindings of their own.
                ANTHROPIC_API_KEY: '',
                AI_GATEWAY_URL: '',
                AI_GATEWAY_TOKEN: '',
                WEB_BOT_AUTH_KEY: '',
                CONSUMER_CROWDIO_TOKEN_HASH: '',
                CONSUMER_CROWDIO_HMAC_KEY: '',
                CONSUMER_CROWDIO_SCOPES: '',
                ACCESS_TEAM_DOMAIN: '',
                ACCESS_AUD: '',
                OWNER_EMAIL: '',
                // The SHA-256 of "test-token", which the API tests send.
                OWNER_TOKEN_HASH:
                  '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e',
                // wrangler.jsonc says whether Cloudflare lists Spatula as a verified bot, and the
                // owner will change it to "true". The status tests expect the shipped "false", so
                // the run pins it. The test that sets it does so on bindings of its own.
                VERIFIED_BOT: 'false',
              },
              // wrangler.jsonc's limiters. The first has room for every write the tests make, and
              // the consumers' keeps its own limit, which the tests' few consumer writes don't
              // reach. The tests of the limits set limiters of their own.
              ratelimits: {
                REVIEW_LIMITER: { namespace_id: '2001', simple: { limit: 1_000_000, period: 60 } },
                CONSUMER_REVIEW_LIMITER: {
                  namespace_id: '2002',
                  simple: { limit: 240, period: 60 },
                },
              },
            },
          })),
        ],
        test: {
          name: 'workers',
          include: ['test/workers/**/*.test.ts'],
          setupFiles: ['test/workers/setup.ts'],
          testTimeout: 60_000,
          // Miniflare keeps one introspection session for each Workflow, so test files that
          // overlapped could hand each other's instances a mocked step.
          fileParallelism: false,
        },
      },
    ],
  },
});
