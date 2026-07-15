# Spatula

**Describe the web data you want and get a clean, structured dataset.**

[![CI](https://github.com/accidentally-awesome-labs/spatula/actions/workflows/ci.yml/badge.svg)](https://github.com/accidentally-awesome-labs/spatula/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Spatula is an AI-assisted crawler that runs locally from your terminal or as a self-hosted API. It crawls permitted pages, extracts typed fields with an LLM, reconciles entities, and exports JSON, CSV, Parquet, SQLite, or DuckDB.

> You are responsible for the terms and laws that apply to every site you crawl. Spatula respects `robots.txt` by default. See the full [legal notice](#legal-and-safety).

## Install and run your first crawl

You need Node.js 22 or newer on macOS, Linux, or Windows through WSL 2.

```bash
npm install --global @accidentally-awesome-labs/spatula --allow-scripts=better-sqlite3
spatula
```

The guided flow:

1. Configures OpenRouter (the default) or Ollama.
2. Asks before downloading the Playwright Chromium browser.
3. Offers a small crawl of `books.toscrape.com`, a practice site made for scraping.
4. Shows the target, page limit, fields, model, and estimated cost before starting.
5. Previews structured entities and gives you the next export command.

API keys entered during setup are saved to `~/.spatula/config.yaml` with user-only permissions. Environment variables override saved values.

### Manual workflow

The individual commands remain available for automation and experienced users:

```bash
mkdir product-crawl && cd product-crawl
spatula setup
spatula init https://example.com/products --limit 25
# Edit spatula.yaml to describe the fields you want.
spatula estimate
spatula run
spatula explore
spatula export --format json
```

Structured extraction requires a configured LLM. `spatula run` now stops with a repair command if one is missing. Use `spatula run --crawl-only` only when you intentionally want to archive pages without extracting entities.

## Project configuration

Each crawl is a folder containing `spatula.yaml`:

```yaml
name: Product catalogue
description: Products and current prices
seeds:
  - https://example.com/products

depth: 2
limit: 25

fields:
  - product_name: string
  - price: currency
  - in_stock: boolean
```

Local state, downloaded pages, logs, and exports live under `.spatula/`. Add that directory to version control ignores; `spatula init` updates an existing `.gitignore` automatically.

## Providers and crawlers

| Purpose | Default    | Alternative | Configuration                                            |
| ------- | ---------- | ----------- | -------------------------------------------------------- |
| LLM     | OpenRouter | Ollama      | `spatula setup`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` |
| Crawler | Playwright | Firecrawl   | `spatula setup`, `FIRECRAWL_API_KEY`                     |

The npm package deliberately has no browser `postinstall` hook. Chromium is downloaded only after the setup prompt, or with `spatula setup --install-browser`. Firecrawl users can choose `--skip-browser`.

## Useful commands

| Command                 | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `spatula`               | Guided first-run and project onboarding                           |
| `spatula doctor`        | Diagnose Node, provider, browser, permissions, and project health |
| `spatula new`           | Build a configuration conversationally                            |
| `spatula run`           | Run structured crawling locally                                   |
| `spatula status`        | Show pages, entities, schema, and last-run state                  |
| `spatula explore`       | Browse entities in the terminal UI                                |
| `spatula review`        | Approve or reject schema changes                                  |
| `spatula export`        | Export JSON, CSV, Parquet, SQLite, or DuckDB                      |
| `spatula logs --errors` | Inspect detailed failures                                         |
| `spatula --version`     | Show the installed CLI version                                    |

Run `spatula --help`, or append `--help` to any command, for the complete command surface.

## Troubleshooting

Start with:

```bash
spatula doctor
```

Common repairs:

- Missing or invalid provider: run `spatula setup`.
- Missing Chromium: run `spatula setup --install-browser`.
- Ollama model missing: start Ollama, then run the `ollama pull ...` command printed by Spatula.
- Crawl failed after starting: run `spatula logs --errors`.
- Start over but retain exports: run `spatula reset --keep-exports`.

Uninstall the CLI with `npm uninstall --global @accidentally-awesome-labs/spatula`. Remove `~/.spatula` separately only if you also want to delete saved settings and keys.

## Self-host the API

The full server needs Docker, PostgreSQL, Redis, and either OpenRouter or Ollama. For a local evaluation:

```bash
git clone https://github.com/accidentally-awesome-labs/spatula.git
cd spatula
cp .env.example .env
# Set OPENROUTER_API_KEY in .env, or configure Ollama.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

The API is at `http://localhost:3000`; interactive OpenAPI documentation is at `http://localhost:3000/api/docs`. `AUTH_STRATEGY=none` is for private local evaluation only. Use API-key or JWT authentication before exposing a deployment.

Operational paths:

- [Docker and reverse proxy](docs/runbooks/reverse-proxy.md)
- [Kubernetes](deploy/k8s/README.md)
- [Render paid starter blueprint](docs/runbooks/render-deploy.md)
- [Backup and restore](docs/runbooks/backup-restore.md)
- [Hardware sizing](docs/runbooks/hardware-sizing.md)

## Develop Spatula

```bash
git clone https://github.com/accidentally-awesome-labs/spatula.git
cd spatula
corepack enable
pnpm install --frozen-lockfile
pnpm build

# Run the CLI directly from source
pnpm --filter @accidentally-awesome-labs/spatula dev -- --help

# Before opening a pull request
pnpm lint
pnpm typecheck
pnpm test
pnpm test:package-install
```

Database-backed tests require `docker compose up -d`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and [docs/architecture.md](docs/architecture.md) for system design.

## SDK and API

- [`@accidentally-awesome-labs/spatula-client`](packages/client/README.md) — typed server client
- [`@accidentally-awesome-labs/spatula-core-types`](packages/core-types/README.md) — public schemas and types
- [API authentication](docs/api-auth.md)
- [Error model](docs/api-errors.md)
- [Compatibility policy](docs/compat-policy.md)

## Legal and safety

Spatula is provided as-is under the [MIT License](LICENSE). You are responsible for complying with website terms and applicable law, including privacy, copyright, and computer-access law. Disabling `robots.txt` enforcement or other safety controls is at your own risk. The project and Accidentally Awesome Labs accept no liability for misuse.

Security issues should be reported through [SECURITY.md](SECURITY.md), not a public issue.
