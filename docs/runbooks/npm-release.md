# npm release runbook

Spatula publishes every public workspace package at one lockstep version. The
root Release Please tag (`spatula-vX.Y.Z`) starts `.github/workflows/release.yml`,
which publishes packages in dependency order and verifies a clean global CLI
install on Linux and macOS.

## One-time first publish

npm trusted publishing is configured from an existing package's settings. The
first release therefore needs a short-lived bootstrap credential.

1. Confirm that the `accidentally-awesome-labs` organization exists on npm and that your npm
   account can create public packages in that scope.
2. Enable two-factor authentication on the npm account.
3. Create a short-lived granular npm access token that can publish packages in
   the `accidentally-awesome-labs` organization and can satisfy the publish 2FA requirement.
4. Add it as the `NPM_TOKEN` Actions secret in
   `accidentally-awesome-labs/spatula`. Do not put it in a local `.npmrc` or in
   the repository.
5. On the release commit, create the component baseline tags at the same
   version and push them before the root tag:

   ```text
   core-v0.1.0
   core-types-v0.1.0
   client-v0.1.0
   db-v0.1.0
   queue-v0.1.0
   shared-v0.1.0
   api-v0.1.0
   cli-v0.1.0
   ```

6. Create and push `spatula-v0.1.0` last. This is the only tag that starts the
   lockstep publish workflow.
7. Wait for `Publish npm Packages` and both `Verify npm install` matrix jobs to
   pass. The publish loop is idempotent, so rerunning a partially completed
   workflow skips versions already present in the registry.
8. In the npm settings for each published package, configure this trusted
   publisher with `npm publish` permission:

   ```text
   Provider: GitHub Actions
   Organization: accidentally-awesome-labs
   Repository: spatula
   Workflow filename: release.yml
   ```

9. Delete the GitHub `NPM_TOKEN` secret and revoke the npm token. All later
   releases authenticate with short-lived GitHub OIDC credentials and publish
   provenance automatically.

Official references: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

## Normal releases

Merge the Release Please PR when it is ready. Release Please creates component
tags at one linked version; the root `spatula-vX.Y.Z` tag starts publication.
No npm token should be present.

The workflow validates that every manifest matches the tag before publishing.
It then performs registry-backed install checks on Ubuntu and macOS before the
GitHub release job completes.

## Local pre-release checks

Run these from the repository root:

```bash
corepack pnpm build
corepack pnpm test
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm audit:packages
corepack pnpm test:package-install
node scripts/check-release-version.mjs spatula-v0.1.0
```

`test:package-install` packs the exact local package dependency closure, installs
the CLI into a clean temporary npm project, and exercises `--version`, `--help`,
and `init` without workspace links.
