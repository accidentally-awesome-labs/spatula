# Wave 1b-ii: CI/CD & Containerization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated quality gates via GitHub Actions CI, create multi-stage Dockerfiles for the API and worker apps, and provide a production Docker Compose configuration.

**Architecture:** Three GitHub Actions workflows handle CI (lint/test/build on every PR), releases (build + push Docker images on tags), and dependency auditing (weekly + lockfile changes). Multi-stage Dockerfiles produce minimal Alpine-based images preserving the pnpm monorepo workspace structure. A production compose file extends the existing dev compose with API and worker services.

**Tech Stack:** GitHub Actions, Docker (multi-stage builds, node:22-alpine), pnpm 9.15.4, Turborepo

**Spec references:**
- Phase 12 spec sections 2.1 (CI/CD Pipeline), 2.2 (Application Dockerfiles), 2.7 (Production Docker Compose)
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `.github/workflows/ci.yml` | CI pipeline: lint, typecheck, format-check, test-unit, test-e2e, build |
| `.github/workflows/release.yml` | Build Docker images on tag, push to GHCR |
| `.github/workflows/audit.yml` | Weekly + lockfile-change dependency audit |
| `Dockerfile.api` | Multi-stage build for API server |
| `Dockerfile.worker` | Multi-stage build for worker processes |
| `Dockerfile.cli` | Multi-stage build for CLI (CI/scripting) |
| `docker-compose.prod.yml` | Production compose extending dev with app services |
| `.dockerignore` | Exclude unnecessary files from Docker builds |

### Modified Files

| File | Change |
|------|--------|
| `.gitignore` | Add `.spatula/` pattern (Phase 13 forward-compat) |

---

## Task 1: Docker Ignore File

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Create .dockerignore**

```
node_modules
dist
.turbo
*.tsbuildinfo
.git
.github
.env
.env.local
.env.example
coverage
.worktrees
.spatula
docs
tests
*.md
!package.json
!pnpm-lock.yaml
!pnpm-workspace.yaml
!.npmrc
!turbo.json
!tsconfig.base.json
```

This excludes build artifacts, docs, tests, and env files from Docker context while keeping all config files needed for the build.

- [ ] **Step 2: Commit**

```bash
git add .dockerignore
git commit -m "chore: add .dockerignore for Docker builds"
```

---

## Task 2: API Dockerfile

**Files:**
- Create: `Dockerfile.api`

- [ ] **Step 1: Create Dockerfile.api**

```dockerfile
# -----------------------------------------------------------
# Stage 1: Install ALL dependencies (dev + prod) and build
# -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# Copy workspace config + ALL package.json files (pnpm requires all workspace
# members present for lockfile resolution, even if not all are used)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/

# Install all dependencies (dev included for building)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# Build the full dependency tree
RUN pnpm run build

# -----------------------------------------------------------
# Stage 2: Production dependencies only
# -----------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/

RUN pnpm install --frozen-lockfile --prod

# -----------------------------------------------------------
# Stage 3: Minimal runtime image
# -----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S spatula && adduser -S spatula -u 1001

# Copy production node_modules (preserves pnpm workspace symlinks)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /app/packages/queue/node_modules ./packages/queue/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules

# Copy built output (preserving monorepo directory structure)
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/queue/dist ./packages/queue/dist
COPY --from=build /app/packages/queue/package.json ./packages/queue/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/package.json ./

USER spatula
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
```

- [ ] **Step 2: Verify Docker build (if Docker available)**

Run: `docker build -f Dockerfile.api -t spatula-api:test .`
Expected: Build completes successfully

If Docker is not available, skip this step (CI will verify).

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.api
git commit -m "feat: add multi-stage Dockerfile for API server"
```

---

## Task 3: Worker Dockerfile

**Files:**
- Create: `Dockerfile.worker`

- [ ] **Step 1: Create Dockerfile.worker**

```dockerfile
# -----------------------------------------------------------
# Stage 1: Install ALL dependencies (dev + prod) and build
# -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# Copy workspace config + ALL package.json files (pnpm requires all workspace
# members present for lockfile resolution)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code (no apps needed for workers — only packages)
COPY tsconfig.base.json ./
COPY packages/ packages/

# Build packages
RUN pnpm run build --filter=@spatula/queue...

# -----------------------------------------------------------
# Stage 2: Production dependencies only
# -----------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/

RUN pnpm install --frozen-lockfile --prod

# -----------------------------------------------------------
# Stage 3: Minimal runtime image
# -----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S spatula && adduser -S spatula -u 1001

# Copy production node_modules (only packages needed by workers)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /app/packages/queue/node_modules ./packages/queue/node_modules

# Copy built output
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/queue/dist ./packages/queue/dist
COPY --from=build /app/packages/queue/package.json ./packages/queue/
COPY --from=build /app/package.json ./

USER spatula
# No EXPOSE — workers don't serve HTTP
CMD ["node", "packages/queue/dist/worker-entrypoint.js"]
```

Key differences from API Dockerfile:
- Does NOT copy `apps/api/` (workers don't need the API code)
- Uses `--filter=@spatula/queue...` for targeted builds
- No `EXPOSE` (workers don't serve HTTP)
- Entry point is `worker-entrypoint.js` (created in Wave 1b-i)

- [ ] **Step 2: Verify Docker build (if Docker available)**

Run: `docker build -f Dockerfile.worker -t spatula-worker:test .`
Expected: Build completes successfully

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.worker
git commit -m "feat: add multi-stage Dockerfile for worker processes"
```

---

## Task 4: CLI Dockerfile

**Files:**
- Create: `Dockerfile.cli`

- [ ] **Step 1: Create Dockerfile.cli**

The CLI image is lighter — it only needs `@spatula/core`, `@spatula/shared`, and `apps/cli`. No database, queue, or API server at runtime. Used for CI/scripting via `docker run spatula-cli <command>`.

```dockerfile
# -----------------------------------------------------------
# Stage 1: Install ALL dependencies and build
# -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/cli/ apps/cli/

RUN pnpm run build

# -----------------------------------------------------------
# Stage 2: Production dependencies only
# -----------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/

RUN pnpm install --frozen-lockfile --prod

# -----------------------------------------------------------
# Stage 3: Minimal runtime
# -----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S spatula && adduser -S spatula -u 1001

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /app/apps/cli/node_modules ./apps/cli/node_modules

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/apps/cli/dist ./apps/cli/dist
COPY --from=build /app/apps/cli/package.json ./apps/cli/
COPY --from=build /app/package.json ./

USER spatula
ENTRYPOINT ["node", "apps/cli/dist/index.js"]
```

Note: Uses `ENTRYPOINT` instead of `CMD` so arguments are passed naturally: `docker run spatula-cli status`.

- [ ] **Step 2: Verify Docker build (if Docker available)**

Run: `docker build -f Dockerfile.cli -t spatula-cli:test .`

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.cli
git commit -m "feat: add multi-stage Dockerfile for CLI"
```

---

## Task 5: Production Docker Compose

**Files:**
- Create: `docker-compose.prod.yml`

- [ ] **Step 1: Create docker-compose.prod.yml**

This file is designed to be used alongside the existing `docker-compose.yml` (which provides postgres and redis) via `docker compose -f docker-compose.yml -f docker-compose.prod.yml up`.

```yaml
# Production-ready compose extending docker-compose.yml with application services.
#
# Usage:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
#
# Or set COMPOSE_FILE in .env:
#   COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml

services:
  # One-shot migration runner — exits after migrations complete
  migrate:
    build:
      context: .
      dockerfile: Dockerfile.api
    command: ["node", "packages/db/dist/run-migrate.js"]
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  # API server
  # Note: deploy.replicas is a Docker Swarm feature. In standalone compose,
  # scale via: docker compose -f ... up --scale api=2
  # With multiple replicas, put a reverse proxy (nginx/traefik) in front.
  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    ports:
      - "3000:3000"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: on-failure
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  # Background workers
  worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: on-failure
```

Design decisions:
- `migrate` runs as a one-shot init container (`restart: "no"`)
- `api` and `worker` depend on `migrate` completing successfully before starting
- Both `api` and `worker` depend on healthy postgres + redis
- Default 2 replicas each (configurable via `docker compose up --scale api=4`)
- API has a healthcheck using wget (Alpine has wget, not curl)
- `.env` file provides all configuration (DATABASE_URL, REDIS_URL, API keys)

- [ ] **Step 2: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat: add production Docker Compose with API, worker, and migration services"
```

---

## Task 6: CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create .github/workflows/ci.yml**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_call:  # Allow release.yml to call this workflow

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.sha }}
          restore-keys: turbo-${{ runner.os }}-
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.sha }}
          restore-keys: turbo-${{ runner.os }}-
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck

  format-check:
    name: Format Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run format:check

  test-unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.sha }}
          restore-keys: turbo-${{ runner.os }}-
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test

  test-e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        ports:
          - 5432:5432
        env:
          POSTGRES_USER: spatula
          POSTGRES_PASSWORD: spatula
          POSTGRES_DB: spatula
        options: >-
          --health-cmd "pg_isready -U spatula"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://spatula:spatula@localhost:5432/spatula
      REDIS_URL: redis://localhost:6379
      OPENROUTER_API_KEY: test-key-not-real
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.sha }}
          restore-keys: turbo-${{ runner.os }}-
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - name: Run migrations
        run: pnpm --filter @spatula/db db:migrate
      - run: pnpm run test:e2e

  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.sha }}
          restore-keys: turbo-${{ runner.os }}-
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
```

Key design choices:
- All 6 jobs run in parallel (no dependencies between them)
- `pnpm/action-setup@v4` auto-detects pnpm version from `packageManager` field
- `actions/setup-node@v4` with `cache: pnpm` caches the pnpm store
- `concurrency` with `cancel-in-progress: true` cancels stale PR runs
- E2E tests use GitHub Actions service containers for postgres and redis
- E2E provides a fake `OPENROUTER_API_KEY` (tests mock LLM calls)
- E2E runs build first (Turbo caches intermediate results)

- [ ] **Step 2: Commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/ci.yml
git commit -m "ci: add CI workflow with lint, typecheck, format, test, build jobs"
```

---

## Task 7: Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create .github/workflows/release.yml**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write
  packages: write

jobs:
  ci:
    name: CI
    uses: ./.github/workflows/ci.yml

  docker:
    name: Build & Push Docker Images
    runs-on: ubuntu-latest
    needs: ci
    strategy:
      matrix:
        include:
          - image: api
            dockerfile: Dockerfile.api
          - image: worker
            dockerfile: Dockerfile.worker
          - image: cli
            dockerfile: Dockerfile.cli
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract version from tag
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          push: true
          tags: |
            ghcr.io/${{ github.repository }}/${{ matrix.image }}:${{ steps.version.outputs.version }}
            ghcr.io/${{ github.repository }}/${{ matrix.image }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  release:
    name: Create GitHub Release
    runs-on: ubuntu-latest
    needs: [ci, docker]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Extract version
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          append_body: true
          body: |
            ## Docker Images

            ```
            docker pull ghcr.io/${{ github.repository }}/api:${{ steps.version.outputs.version }}
            docker pull ghcr.io/${{ github.repository }}/worker:${{ steps.version.outputs.version }}
            docker pull ghcr.io/${{ github.repository }}/cli:${{ steps.version.outputs.version }}
            ```
```

Key design choices:
- Triggers on `v*` tags (e.g., `v1.0.0`)
- Runs full CI first (reuses ci.yml as a called workflow)
- Matrix strategy builds API and worker images in parallel
- Docker layer caching via GitHub Actions cache (`type=gha`)
- Images tagged with both version and `latest`
- Published to GitHub Container Registry (GHCR)
- Auto-generates changelog from commit messages between tags
- Creates GitHub Release with changelog and docker pull commands

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow for Docker image builds and GitHub releases"
```

---

## Task 8: Dependency Audit Workflow

**Files:**
- Create: `.github/workflows/audit.yml`

- [ ] **Step 1: Create .github/workflows/audit.yml**

```yaml
name: Dependency Audit

on:
  schedule:
    - cron: '0 9 * * 1'  # Weekly on Monday at 9am UTC
  push:
    paths:
      - 'pnpm-lock.yaml'
    branches: [main]
  workflow_dispatch:  # Allow manual trigger

jobs:
  audit:
    name: Security Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Run audit
        run: pnpm audit --audit-level=high
```

Simple and focused:
- Runs weekly (Monday 9am UTC)
- Also runs when `pnpm-lock.yaml` changes on main
- Fails on high/critical vulnerabilities
- Manual trigger available via `workflow_dispatch`

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/audit.yml
git commit -m "ci: add weekly dependency audit workflow"
```

---

## Task 9: Update .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add .spatula/ to .gitignore**

Append to the existing `.gitignore`:

```
.spatula/
```

This is a forward-compatibility addition for Phase 13's project-folder model. The `.spatula/` directory will contain local project state (SQLite DB, page cache, exports) that should never be committed.

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add .spatula/ to .gitignore for Phase 13 forward-compat"
```

---

## Task 10: Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Verify all new files exist**

Run:
```bash
ls -la .dockerignore Dockerfile.api Dockerfile.worker Dockerfile.cli docker-compose.prod.yml .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/audit.yml
```
Expected: All 8 files listed

- [ ] **Step 2: Validate YAML syntax**

Run:
```bash
# Validate docker-compose files
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet 2>&1 || echo "docker compose not available, skipping validation"
```

- [ ] **Step 3: Validate GitHub Actions syntax (if act is available)**

Run:
```bash
which act && act --list || echo "act not installed, skipping workflow validation"
```

If `act` is not available, the workflows will be validated by GitHub on first push. This is acceptable.

- [ ] **Step 4: Verify existing tests still pass**

Run:
```bash
pnpm run test 2>&1 | tail -20
```
Expected: All tests pass (these are config files only — no code changes that could break tests)

- [ ] **Step 5: Commit verification**

```bash
git log --oneline -10
```

Expected: 8 clean commits for Wave 1b-ii.
