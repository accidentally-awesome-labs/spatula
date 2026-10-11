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
                // .dev.vars can't make these tests call a paid model.
                ANTHROPIC_API_KEY: '',
                AI_GATEWAY_URL: '',
                AI_GATEWAY_TOKEN: '',
                // The SHA-256 of "test-token", which the API tests send.
                OWNER_TOKEN_HASH:
                  '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e',
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
