# Contributing to Spatula

Thank you for your interest in contributing! This guide covers how to set up your development environment and submit changes.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9.15+
- Docker (for PostgreSQL and Redis)
- Playwright browsers: `npx playwright install`

### Setup

```bash
# Clone and install
git clone https://github.com/spatulaai/spatula.git
cd spatula
pnpm install

# Start database services
docker compose up -d

# Copy environment config
cp .env.example .env
# Edit .env with your settings (at minimum: OPENROUTER_API_KEY)

# Run database migrations
pnpm --filter @spatula/db migrate

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Development Workflow

### Branch Naming

- `feat/short-description` — new features
- `fix/short-description` — bug fixes
- `docs/short-description` — documentation
- `refactor/short-description` — code restructuring

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add parquet export format
fix: handle null fields in CSV exporter
docs: update CLI command reference
test: add schema evolution edge cases
chore: update dependencies
```

Scopes are optional but helpful for monorepo navigation:

```
feat(core): add CSS selector extraction fallback
fix(api): return 404 for cross-tenant action approve
```

## Code Style

- **ESLint** — `pnpm lint` (auto-fixable: `pnpm lint --fix`)
- **Prettier** — `pnpm format:check` (auto-fix: `pnpm format`)
- **TypeScript** — strict mode, `pnpm typecheck`

All three run in CI on every push.

## Testing

```bash
# Run all unit tests
pnpm test

# Run E2E tests (requires Docker services running)
pnpm test:e2e

# Run tests for a specific package
pnpm --filter @spatula/core test

# Run a specific test file
pnpm --filter @spatula/core test -- src/tests/unit/extraction/llm-extractor.test.ts
```

### Test Guidelines

- Place tests next to source files or in a parallel `tests/` directory matching the source structure
- Unit tests: test individual functions/classes in isolation
- Integration tests: test interactions between components (may use in-memory SQLite)
- E2E tests: test full API workflows against Postgres + Redis (in `tests/e2e/`)

## Project Structure

```
spatula/
├── apps/
│   ├── api/          # Hono REST API server
│   └── cli/          # CLI + TUI application
├── packages/
│   ├── core/         # Types, interfaces, pipeline logic (no I/O deps)
│   ├── db/           # PostgreSQL + SQLite, Drizzle ORM
│   ├── queue/        # BullMQ workers, webhooks
│   └── shared/       # Logging, auth, metrics, errors
├── tests/
│   └── e2e/          # End-to-end API tests
├── examples/         # Example project configurations
└── docs/             # Architecture and design documentation
```

See [docs/architecture.md](docs/architecture.md) for a detailed architecture guide.

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Ensure all checks pass: `pnpm lint && pnpm typecheck && pnpm test`
4. Push and open a pull request
5. Fill out the PR template
6. Address review feedback

## Reporting Issues

Use [GitHub Issues](https://github.com/spatulaai/spatula/issues) with the provided templates:

- **Bug reports** — include steps to reproduce, expected vs actual behavior, and your environment
- **Feature requests** — describe the use case and proposed solution

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Contributor License Agreement (CLA)

All contributors must sign the Spatula Individual Contributor License Agreement before
their first pull request can be merged.

**How it works:**

1. Open a pull request against the Spatula repository.
2. The **cla-assistant.io** bot will automatically comment on your PR with a link to
   sign the CLA.
3. Sign once using your GitHub account. Your signature is recorded by cla-assistant.io
   and linked to your GitHub identity.
4. Future pull requests from the same GitHub account will be automatically recognized
   as signed — you do not need to sign again (unless the CLA text changes; see below).

The full CLA text is in [.github/CLA.md](.github/CLA.md).

**Re-sign policy:**

The CLA is versioned. When the `version` field in the frontmatter of `.github/CLA.md` is
incremented (indicating a material change to the CLA text), past signatories must
**re-sign** on their next pull request. The cla-assistant.io bot detects the text change
automatically and will prompt you to re-sign. This re-sign-on-version-bump policy ensures
all contributors have agreed to the current CLA terms.

**AI-generated contributions:**

Contributions generated substantially by AI tools (e.g., GitHub Copilot, ChatGPT,
Claude) are permitted, but you as the submitter are responsible for ensuring: (a) the
contribution meets the quality bar, (b) you have reviewed and understood the code, and
(c) no third-party copyrighted material is included without proper attribution. You still
sign the CLA as the submitting contributor.

**License allowlist:**

All third-party dependencies introduced in a pull request must use a license from the
following allowlist: MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0, 0BSD, CC0-1.0,
Unlicense. GPL, AGPL, LGPL, BUSL, and other copyleft or source-available licenses are
NOT permitted without explicit prior written approval from Accidentally Awesome Labs.
The CI `audit.yml` workflow enforces this check automatically.
