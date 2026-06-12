# Render Deploy Runbook

Deploy Spatula on a Render free-tier account using the repo-root `render.yaml` blueprint.

---

## What this is

A **try-it / demo path** — not a production recommendation.

The `render.yaml` blueprint provisions everything needed to run the full Spatula stack on a Render free-tier account in a single "New > Blueprint" step. It runs the API server and the BullMQ worker **in the same process** on one free Web Service (controlled by `SPATULA_EMBEDDED_WORKER=1`).

**Production splits the API and worker into separate services.** Render's Background Worker service type is not available on the free plan — paid plans should provision a dedicated Worker service for the queue workers and remove `SPATULA_EMBEDDED_WORKER=1`. For production-grade self-hosting see the Kubernetes path (`deploy/k8s/README.md`) or the Docker Compose path (`docker-compose.prod.yml`).

---

## What is provisioned

| Resource        | Render type                | Plan |
| --------------- | -------------------------- | ---- |
| `spatula-api`   | Web Service (node runtime) | free |
| `spatula-cache` | Key Value (Redis)          | free |
| `spatula-db`    | PostgreSQL                 | free |

The blueprint wires `DATABASE_URL` and `REDIS_URL` automatically from the managed services — no manual URL copying needed.

---

## Deploy steps

### 1. Fork / clone the repo

```bash
git clone https://github.com/accidentally-awesome-labs/spatula.git
```

Or fork to your own GitHub account and proceed from there.

### 2. Create a Blueprint on Render

1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New > Blueprint**.
3. Connect your GitHub account and select the `spatula` repo (or your fork).
4. Render reads `render.yaml` at the repo root and proposes the three resources listed above.

### 3. Set secrets in the Render dashboard

Before clicking **Apply**, set any `sync: false` environment variables (these are NOT stored in the YAML for security):

| Variable                 | Required               | Description                                                   |
| ------------------------ | ---------------------- | ------------------------------------------------------------- |
| `OPENROUTER_API_KEY`     | Yes                    | LLM inference key from [openrouter.ai](https://openrouter.ai) |
| `AUTH_STRATEGY`          | No                     | Auth mode: `none` (default), `api-key`, or `jwt`              |
| `JWT_ISSUER`             | If `AUTH_STRATEGY=jwt` | OIDC issuer URL                                               |
| `JWT_AUDIENCE`           | If `AUTH_STRATEGY=jwt` | JWT audience claim                                            |
| `JWT_JWKS_URL`           | If `AUTH_STRATEGY=jwt` | JWKS endpoint                                                 |
| `TENANT_CREATION_SECRET` | No                     | Protect `/api/v1/tenants` bootstrap route in production       |
| `SENTRY_DSN`             | No                     | Sentry error tracking DSN                                     |

### 4. Apply and wait for the deploy

Click **Apply**. Render provisions the PostgreSQL database and Key Value store first, then builds and deploys the Web Service. Initial build takes 3–7 minutes (pnpm install + full monorepo build).

### 5. Run database migrations

The free tier does not support `preDeployCommand`, so migrations must be run manually after the first deploy:

1. In the Render dashboard, navigate to the **spatula-api** Web Service.
2. Click **Shell** (or use the Render CLI: `render ssh spatula-api`).
3. Run:
   ```bash
   node packages/db/dist/run-migrate.js
   ```
4. Confirm the output shows migrations applied successfully.

On subsequent deploys, re-run this step if new migrations are included in the release. Check the release notes or `packages/db/drizzle/` for new migration files.

### 6. Verify the deployment

Hit the assigned `*.onrender.com` URL:

```bash
curl https://spatula-api-XXXX.onrender.com/health
```

Expected response: HTTP 200 with a JSON health payload.

To confirm the embedded worker is active, check the Web Service logs for:

```
Embedded worker started (SPATULA_EMBEDDED_WORKER=1)
```

Or submit a small job via the API and confirm it processes within a few seconds.

---

## Free-tier caveats

These limitations apply to all Render free-tier resources. This blueprint is framed as a demo path because of them — do not use it for production workloads.

### Web Service spin-down

The free Web Service **spins down after 15 minutes of inactivity**. The next request after a spin-down triggers a cold start that takes approximately 30 seconds. During that cold start, HTTP requests will fail or time out.

Because the worker runs in the same process as the API (`SPATULA_EMBEDDED_WORKER=1`), the worker also spins down. Any in-flight crawl job that was running when the service spun down is **lost** — it will not resume automatically. Users should re-submit jobs after a restart.

### Key Value (Redis) — no persistence

The free Render Key Value instance **does not persist data to disk**. All Redis data (BullMQ job queues, stream tokens, caching) is **lost on every restart or spin-down cycle**. Submitted jobs that were queued in Redis but not yet processed are lost when the service restarts.

This is a known limitation of the free tier ([render.com/docs/free](https://render.com/docs/free)). Paid Key Value instances support persistence.

### PostgreSQL expiry

Free Render PostgreSQL databases **expire 30 days after creation**, with a **14-day grace period** to upgrade before Render deletes the database and its data. See [render.com/docs/free](https://render.com/docs/free) for current terms.

Back up your data before the 30-day mark:

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl -f spatula-backup.sql
```

Upgrade to a paid Postgres plan in the Render dashboard to remove this limit.

### One free Postgres + one free Key Value per workspace

Render enforces a limit of **one free PostgreSQL database** and **one free Key Value** per workspace. If you already have other free-tier resources, you may need to remove them or upgrade before deploying this blueprint.

---

## EXEC-05 Live Re-verify Procedure (Phase 19.1 — clearing the 19-05 caveat)

The Phase 19-05 live deploy confirmed the worker starts and `/health` returns 200, but a real
crawl DLQ'd with `WorkerDeps not initialized`. Phase 19.1 fixed the three gaps
(worker DI, per-job LLM config, usage recording). This section documents how to re-verify
a live crawl on the Render embedded-worker deploy.

### Distroless → Firecrawl requirement

The distroless Render worker image (`apps/api/Dockerfile.api`) ships **NO Playwright browser
binaries**. Any crawl submitted to the Render deploy MUST use Firecrawl:

```
SPATULA_CRAWLER=firecrawl
FIRECRAWL_API_KEY=<your-key>
```

Without these, crawl tasks will fail immediately (Playwright not found in the container).

### Service reference

| Property     | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| Service ID   | `srv-d8lh2q6rnols73dedvog`                                   |
| URL          | `https://spatula-api.onrender.com`                           |
| Branch       | `render-paid-demo` (paid mirror — free PG/KV slots occupied) |

### SPATULA_CRAWLER in render.yaml

`render.yaml` does NOT commit `SPATULA_CRAWLER` to git (it's a runtime setting, not blueprint).
Set it via the Render dashboard on the `spatula-api` Web Service **before** syncing:

1. Render dashboard → `spatula-api` → **Environment** tab
2. Add: `SPATULA_CRAWLER=firecrawl` (unencrypted, safe to expose)
3. Add: `FIRECRAWL_API_KEY=<your key>` (mark as **Secret**)
4. Add/update: `OPENROUTER_API_KEY=<your key>` (mark as **Secret**)

> **Blueprint Sync ≠ deploy.** `render deploys create` reuses the service's stored config.
> Only a Dashboard Blueprint Sync picks up `render.yaml` changes. The OSS repo has no
> auto-sync webhook, so pushes do NOT auto-deploy.

### Re-verify steps (EXEC-05)

```bash
# 1. Push 19.1 fixes to the deploy branch
git push origin main:render-paid-demo

# 2. In the Render dashboard:
#    a. Set OPENROUTER_API_KEY, SPATULA_CRAWLER=firecrawl, FIRECRAWL_API_KEY as above
#    b. Navigate to the Blueprint → click "Sync" (NOT just redeploy)
#    c. Wait for the deploy to complete and /health to return 200

# 3. Verify health
curl https://spatula-api.onrender.com/health
curl https://spatula-api.onrender.com/health/ready

# 4. Run the sizing smoke (Firecrawl crawler, small page count to limit cost):
SPATULA_LIVE_LLM=1 \
  SIZING_PAGES=3 SIZING_MAX_DEPTH=5 \
  SIZING_CRAWLER=firecrawl \
  SPATULA_API_URL=https://spatula-api.onrender.com \
  pnpm sizing:baseline

# 5. Confirm results:
#    - At least one tier job reaches 'completed' with stats.pagesCompleted > 0
#    - GET https://spatula-api.onrender.com/api/v1/usage?period=1d shows:
#        totalCostUsd > 0 (or tokens > 0 if model is free-tier)
#        byJob contains the job's entry
```

**Success criteria (EXEC-05):** A job submitted to the Render deploy reaches `completed` with
`pagesCompleted > 0` and the `/usage` endpoint records tokens (and cost if model is paid).
This clears the 19-05/DEPLOY-02 caveat (worker was starting but couldn't process crawls).

---

## Upgrading to production

When ready to move beyond the free demo tier:

| Path                   | Guide                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes (kustomize) | `deploy/k8s/README.md` — dev overlay on kind; prod overlay for managed Postgres/Redis                                                                                  |
| Docker Compose         | `docker-compose.prod.yml` — separate api, worker, migrate services with healthcheck gating                                                                             |
| Render paid plan       | Upgrade `spatula-api` to a paid web service; add a dedicated Background Worker service; remove `SPATULA_EMBEDDED_WORKER=1`; upgrade Postgres + Key Value to paid plans |

For backup and restore procedures see `docs/runbooks/backup-restore.md`.
For reverse proxy configuration (nginx) see `docs/runbooks/reverse-proxy.md`.
