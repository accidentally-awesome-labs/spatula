# @spatula/cli

Spatula CLI — AI-powered intelligent web crawling, terminal-first.

```bash
npm install -g @spatula/cli
spatula setup       # one-time: download Playwright browsers
spatula init        # create a new project
spatula run         # execute the local crawl pipeline
spatula doctor      # diagnostic checks
```

## Stability

`@spatula/cli` is one of three public, semver-stable Spatula packages (alongside `@spatula/client` and `@spatula/core-types`). See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full SDK ↔ server ↔ core-types compatibility matrix.

The full command surface, flag set, and config file shape (`spatula.yaml`) are part of the public contract and follow [`docs/deprecation-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/deprecation-policy.md) for breaking changes.

## Modes

The CLI ships four interactive modes, all built on Ink (React-for-terminals):

- **Conversational** — describe your data in plain language; the LLM proposes a job config.
- **Dashboard** — live status across runs (page budget, LLM cost, quality scores).
- **Review** — accept/modify schema-evolution actions before they apply.
- **Explorer** — paginate entities + extracted fields with provenance.

## Publishing

`@spatula/cli` is built via [`tsup`](https://tsup.egoist.dev) producing a dual ESM + CJS output with TypeScript declaration files:

```bash
pnpm --filter @spatula/cli build   # tsup --config tsup.config.ts → dist/
pnpm --filter @spatula/cli pack    # produces an installable .tgz
```

The published tarball contents are governed by the `files` allowlist in `package.json` (not `.npmignore`), per spec §3.2.3. Provenance attestation (`--provenance`) and trusted publishing via GitHub OIDC are wired in `.github/workflows/release.yml`.

### No postinstall script

`@spatula/cli` deliberately ships **no `postinstall` script**. Playwright browsers (needed for the headless crawler) are installed via the explicit `spatula setup` command. This avoids surprising downloads on `npm install -g`, makes the install reproducible in CI, and lets users opt out of Playwright if they only need Firecrawl-backed crawls.

```bash
spatula setup          # downloads ~300 MB of Playwright browsers under ~/.cache/ms-playwright
spatula setup --skip   # symbolic — emits a hint if browsers are missing later
```

## Engines

- Node.js ≥ 22 (LTS)
- macOS, Linux, Windows via WSL — see [`docs/support-matrix.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/support-matrix.md)

## Compatibility

`@spatula/cli` may speak to any Spatula server within the same major version. Major-version mismatch triggers a clear error at first request via the version probe in `@spatula/client` (see `docs/compat-policy.md`).
