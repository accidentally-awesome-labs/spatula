# Technology Stack

**Analysis Date:** 2025-05-06

## Languages

**Primary:**

- TypeScript 5.7.0 - All packages and apps, strict mode enabled
- JavaScript - Build scripts and config files (ESM)
- TSX - React components in CLI app (`apps/cli`)

**Secondary:**

- SQL - PostgreSQL and SQLite database definitions and migrations
- YAML - Configuration and seed data formats

## Runtime

**Environment:**

- Node.js 22 (Alpine Linux base in production)
- Module system: ESM (ES2022 target)

**Package Manager:**

- pnpm 9.15.4 (workspace monorepo)
- Lockfile: `pnpm-lock.yaml` (committed for reproducible installs)

## Frameworks & Core Libraries

**Web Framework:**

- Hono 4.12.7 - REST API framework (`apps/api`)
  - `@hono/node-server` 1.19.11 - Node.js HTTP server adapter
  - `@hono/node-ws` 1.3.0 - WebSocket support
  - `@hono/zod-openapi` 0.19.10 - OpenAPI schema generation with Zod validation
  - `@hono/swagger-ui` 0.6.1 - Swagger UI integration

**CLI/TUI:**

- Ink 5.1.0 - React-based terminal UI (`apps/cli`)
  - `ink-spinner` 5.0.0 - Loading spinners
  - `ink-text-input` 6.0.0 - Terminal text input
  - `ink-testing-library` 4.0.0 (dev) - Testing utilities for Ink components
- Yargs 17.7.2 - CLI argument parsing
- Node-notifier 10.0.1 - System notifications
- React 18.3.1 - Component library for Ink
- Zustand 5.0.0 - Client-side state management (CLI)

**Database & ORM:**

- Drizzle ORM 0.45.1 - TypeScript-first ORM for SQL
  - `drizzle-kit` 0.31.10 - Schema generator and migration tooling
- PostgreSQL Driver: `pg` 8.20.0 - Production database
- SQLite Driver: `better-sqlite3` 12.8.0 - Local/embedded project databases
- ioredis 5.10.0 - Redis client for caching and locks

**Job Queue:**

- BullMQ 5.70.4 - Redis-backed job queue
  - `@bull-board/api` 6.20.6 - Job queue monitoring API
  - `@bull-board/hono` 6.20.6 - Hono integration for Bull Board
  - `@bull-board/ui` 6.20.6 - Web UI for queue inspection

**Data Processing & Parsing:**

- Cheerio 1.2.0 - HTML parsing and DOM manipulation
- Zod 3.24.0 - Runtime schema validation
- YAML 2.8.3 - YAML parsing and serialization
- robots-parser 3.0.1 - robots.txt parsing

**File Format Support:**

- hyparquet 1.25.1 - Parquet file reading
- hyparquet-writer 0.13.0 - Parquet file writing

**Database Engines:**

- PostgreSQL 16 (Alpine) - Primary production database (Docker)
- Redis 7 (Alpine) - Job queue and caching backend (Docker)
- DuckDB API - `@duckdb/node-api` 1.5.0-r.1 - Analytics and data manipulation

**Authentication & Security:**

- jose 6.2.2 - JWT signing and verification (optional JWT auth)
- @sentry/node 10.46.0 - Error tracking and observability
- Stripe SDK 22.0.0 - Payment processing and metering integration

**Web Crawling:**

- Playwright 1.58.2 - Browser automation for crawling
- @mendable/firecrawl-js 4.15.4 - Third-party crawling API (optional)

**Cloud Storage:**

- @aws-sdk/client-s3 3.1019.0 - S3-compatible object storage client
- @aws-sdk/s3-request-presigner 3.1019.0 - Presigned URL generation

**OpenTelemetry (Observability):**

- @opentelemetry/api 1.9.1 - OpenTelemetry API
- @opentelemetry/sdk-trace-node 2.6.1 - Node.js tracing
- @opentelemetry/sdk-metrics 2.6.1 - Metrics collection
- @opentelemetry/exporter-trace-otlp-http 0.214.0 - OTLP trace export
- @opentelemetry/exporter-prometheus 0.214.0 - Prometheus metrics export
- @opentelemetry/auto-instrumentations-node 0.72.0 - Auto-instrumentation
- @opentelemetry/instrumentation 0.214.0 - Instrumentation API
- @opentelemetry/resources 2.6.1 - Resource attributes
- @opentelemetry/semantic-conventions 1.40.0 - Semantic conventions

**Logging:**

- Pino 9.6.0 - JSON structured logging
- pino-pretty 13.1.3 (dev) - Pretty-printing for development

**Testing:**

- Vitest 2.1.0 - Vite-native unit test framework
  - Config files: `vitest.config.ts` in packages/apps
  - E2E test config: `tests/e2e/vitest.config.ts`

**Build & Development:**

- TypeScript 5.7.0 - Type checking and compilation
- Turbo 2.4.0 - Monorepo task orchestration
- TSX 4.19.0 - TypeScript executor for scripts
- Prettier 3.4.0 - Code formatting
- ESLint 9.16.0 with @typescript-eslint 8.18.0 - Linting

## Configuration Files

**TypeScript:**

- `tsconfig.base.json` - Root configuration (ES2022, strict mode, ESM)
- `tsconfig.json` in each package/app - Package-specific extends

**Monorepo:**

- `turbo.json` - Turborepo task definitions and caching
- `pnpm-workspace.yaml` - Workspace configuration

**Linting & Formatting:**

- `eslint.config.mjs` - Flat config (new ESLint v9 format)
  - Rules: no-unused-vars (with `_` prefix exemption), no-explicit-any warn, consistent-type-imports error, no-console warn
- `.prettierrc` - Code formatting (semi, single quotes, trailing commas, 100 char line width, 2 spaces)

**Database Migrations:**

- `packages/db/drizzle.config.ts` - PostgreSQL configuration
- `packages/db/drizzle.config.sqlite.ts` - SQLite configuration

**Docker:**

- `Dockerfile.api` - Multi-stage build for API server (Node 22 Alpine)
- `Dockerfile.cli` - Multi-stage build for CLI binary (Node 22 Alpine)
- `Dockerfile.worker` - Multi-stage build for job workers (Node 22 Alpine)
- `docker-compose.yml` - Local development: PostgreSQL 16 + Redis 7
- `docker-compose.prod.yml` - Production variant

## Platform Requirements

**Development:**

- Node.js 22+
- pnpm 9.15.4+
- Docker & Docker Compose (for PostgreSQL, Redis, local testing)
- Playwright browsers (auto-installed on first run)

**Production:**

- Node.js 22 (Alpine Linux)
- PostgreSQL 16+
- Redis 7+
- Optional: S3-compatible storage, Sentry account, OpenTelemetry collector, Stripe account

**Deployment Targets:**

- Containerized (Docker)
- Kubernetes-compatible via Helm/manifests
- Self-hosted or cloud platforms (AWS, GCP, Azure, Render, Railway, etc.)

## Package Structure

**Packages (shared/reusable):**

- `@spatula/core` - Core types, interfaces, pipeline logic, crawlers, LLM clients, content storage
- `@spatula/db` - PostgreSQL/SQLite database layer, Drizzle ORM schemas, repositories
- `@spatula/queue` - BullMQ job queues, workers, webhooks, metering
- `@spatula/shared` - Logging, auth, observability, errors, metrics, tracing

**Apps (executables):**

- `@spatula/api` - Hono REST API server with Bull Board UI
- `@spatula/cli` - Command-line tool with Ink-based TUI

---

_Stack analysis: 2025-05-06_
