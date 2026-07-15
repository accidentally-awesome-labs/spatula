# @accidentally-awesome-labs/spatula

Spatula CLI — AI-powered intelligent web crawling, terminal-first.

```bash
npm install -g @accidentally-awesome-labs/spatula --allow-scripts=better-sqlite3
spatula             # guided setup, safe sample, crawl, and result preview
```

The guided flow stores credentials in a user-only config file, asks before the
Playwright Chromium download, verifies that the browser launches, estimates
cost, and stops with actionable remediation rather than silently producing an
empty dataset.

For a manual workflow, use `spatula setup`, `spatula init <url>`, and
`spatula run`. Structured extraction is required by default; use
`spatula run --crawl-only` to explicitly archive pages without an LLM.

## Stability

`@accidentally-awesome-labs/spatula` is one of three public, semver-stable Spatula packages (alongside `@accidentally-awesome-labs/spatula-client` and `@accidentally-awesome-labs/spatula-core-types`). See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full SDK ↔ server ↔ core-types compatibility matrix.

The full command surface, flag set, and config file shape (`spatula.yaml`) are part of the public contract and follow [`docs/deprecation-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/deprecation-policy.md) for breaking changes.

## Modes

The CLI ships four interactive modes, all built on Ink (React-for-terminals):

- **Conversational** — describe your data in plain language; the LLM proposes a job config.
- **Dashboard** — live status across runs (page budget, LLM cost, quality scores).
- **Review** — accept/modify schema-evolution actions before they apply.
- **Explorer** — paginate entities + extracted fields with provenance.

## Publishing

`@accidentally-awesome-labs/spatula` is built via [`tsup`](https://tsup.egoist.dev) producing a dual ESM + CJS output with TypeScript declaration files:

```bash
pnpm --filter @accidentally-awesome-labs/spatula build   # tsup --config tsup.config.ts → dist/
pnpm --filter @accidentally-awesome-labs/spatula pack    # produces an installable .tgz
```

The published tarball contents are governed by the `files` allowlist in `package.json` (not `.npmignore`). Provenance attestation (`--provenance`) and trusted publishing via GitHub OIDC are wired in `.github/workflows/release.yml`.

### No postinstall script

`@accidentally-awesome-labs/spatula` deliberately ships **no `postinstall` script**. The install command explicitly allows only the native SQLite dependency's build script. Playwright browsers (needed for the headless crawler) are installed via the explicit `spatula setup` command. This avoids surprising browser downloads during package installation, makes the install reproducible in CI, and lets users opt out of Playwright if they only need Firecrawl-backed crawls.

```bash
spatula setup                    # asks before downloading Chromium
spatula setup --install-browser  # install without the browser confirmation
spatula setup --skip-browser     # configure a Firecrawl-only environment
```

## Engines

- Node.js ≥ 22 (LTS)
- macOS, Linux, Windows via WSL — see [`docs/support-matrix.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/support-matrix.md)

## Compatibility

`@accidentally-awesome-labs/spatula` may speak to any Spatula server within the same major version. Major-version mismatch triggers a clear error at first request via the version probe in `@accidentally-awesome-labs/spatula-client` (see `docs/compat-policy.md`).
