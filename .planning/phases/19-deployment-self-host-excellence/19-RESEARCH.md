# Phase 19: Deployment & Self-Host Excellence — Research

**Researched:** 2026-06-10
**Domain:** Container images (distroless, multi-arch), Kubernetes/kustomize, Render PaaS, cosign keyless signing, SBOM, backup/upgrade/config test harnesses
**Confidence:** HIGH (architecture patterns); MEDIUM (Render free tier caveats); HIGH (cosign/kustomize patterns)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01/02/03:** Hardware-sizing baseline measured LIVE on one defined cloud VM class (~4 vCPU / 8 GB / SSD — researcher to name explicitly), all three routing tiers (fast/primary/smart), 3 live 1k-page crawls. A laptop is rejected as a proxy.
- **D-04:** KEYLESS cosign — GitHub Actions OIDC → Fulcio short-lived cert → signature in Rekor. No private signing key.
- **D-05:** SBOM (cyclonedx-json) attached BOTH as a GitHub release asset AND via `cosign attest` as an OCI attestation.
- **D-06:** Render free tier has no Background Worker type. The blueprint runs the worker in-process with the API on one free Web Service, behind an env flag. Runbook must clearly state production splits api and worker.
- **D-07:** Render-managed free Postgres + free Key Value (Redis) in the blueprint. Runbook documents the free-tier caveats: Postgres 90-day expiry and web-service spin-down on inactivity.
- **D-08:** k8s secrets = plain `Secret` manifest with clearly-marked placeholder values. external-secrets / sealed-secrets are documented upgrade paths only.
- **D-09:** Dev overlay ships throwaway in-cluster Postgres + Redis pods (self-contained on kind). Prod overlay strips the stubs, references external managed services.

### Claude's Discretion

- Migrate image topology: default to a dedicated `Dockerfile.migrate` (distroless, db-package deps only). Acceptable alternative: reuse api image with command override. SC#3 requires four signed images either way.
- Heavy-test CI cadence: default the new `tests/e2e/backup/`, `tests/upgrade/`, `tests/config/` lanes + the min-version matrix to run on-release + nightly (not every PR).
- Distroless base image selection (e.g. `gcr.io/distroless/nodejs22-debian12`), buildx caching strategy, exact kind/Render smoke-test harness, runbook prose structure, time-to-restore estimate methodology.

### Deferred Ideas (OUT OF SCOPE)

- First-party Helm chart (v1.1 item; add ROADMAP.md note; chart itself is not in scope).
- traefik / caddy reverse-proxy recipes (community-contributed stubs with "not first-party tested" disclaimer only; nginx is the only tested recipe).
- Full CI topology + devcontainer (Phase 21).
- Release-workflow launch polish + post-publish smoke + cosign-in-launch-runbook (Phase 22).
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DEPLOY-01 | `deploy/k8s/` kustomize base + dev/prod overlays; api, worker, migrate job; applies cleanly to kind | Kustomize directory pattern + Job/initContainer ordering + dev stub pods confirmed |
| DEPLOY-02 | `render.yaml` at repo root deploys on Render free-tier | render.yaml schema verified; free Web Service + Postgres + Key Value confirmed; embedded-worker gap identified |
| DEPLOY-03 | Multi-arch images (amd64+arm64) via buildx; distroless api/worker/migrate; Debian-slim cli | distroless nodejs22-debian12 confirmed; pnpm deploy pattern confirmed; better-sqlite3 cross-compile risk flagged |
| DEPLOY-04 | cosign-signed images + SBOM (cyclonedx-json) on release; cosign verify on fresh machine | keyless cosign workflow pattern confirmed; anchore/sbom-action + cosign attest pattern confirmed |
| DEPLOY-05 | `docs/runbooks/backup-restore.md` + `tests/e2e/backup/` round-trip | ContentStore interface confirmed (no `listKeys`); pg_dump + ContentStore iterate pattern defined |
| DEPLOY-06 | `docs/runbooks/upgrade.md` version-to-version migration template | Existing upgrade.md confirmed; template section to add |
| DEPLOY-07 | `docs/runbooks/reverse-proxy.md` nginx tested; traefik/caddy stubs | nginx config pattern confirmed; token-in-URL log masking pattern confirmed |
| DEPLOY-08 | `docs/support-matrix.md` + min-version CI matrix | GH Actions service container matrix pattern confirmed from existing ci.yml |
| DEPLOY-09 | `docs/runbooks/hardware-sizing.md` measured 1k-page baseline | SPATULA_LIVE_LLM gate pattern confirmed; existing usage/cost API reusable |
| DEPLOY-10 | `tests/upgrade/` seeds v1.0 DB, applies v1.x migrations, verifies runtime | 0000_v1_baseline.sql exists; upgrade test approach confirmed |
| DEPLOY-11 | `tests/config/` verifies v1.0 `spatula.yaml` parses on v1.1 runtime | parseProjectYamlFile in @spatula/core confirmed as validation surface |
</phase_requirements>

---

## Summary

Phase 19 assembles three distinct delivery areas: (1) **container image hardening** — multi-arch distroless builds, supply-chain signing, and a dedicated migrate image; (2) **deployment targets** — kustomize k8s manifests (dev/prod overlays, kind-testable) and a Render free-tier blueprint; and (3) **operational assurance** — backup/upgrade/config test suites, runbooks, support matrix, and a measured hardware-sizing baseline.

The most important architectural discovery is that **the embedded-worker mode required by D-06 does not currently exist in `apps/api/src/`**. The worker-entrypoint.ts is a completely separate process; the API app has no mechanism to start BullMQ workers in-process. A small, deployment-only shim must be added: when `SPATULA_EMBEDDED_WORKER=1` is set, the API start sequence should import and execute the worker-entrypoint's `main()` alongside the HTTP server. This is the riskiest new-code addition in the phase and must be planned explicitly.

The second critical finding is that **distroless nodejs22 images use `node` as their ENTRYPOINT** and expect `CMD ["path/to/dist/index.js"]`. The current Dockerfiles use `CMD ["node", "path/to/dist/index.js"]`, which will cause a double-invocation under distroless (node node ...). The fix is to switch to `CMD ["apps/api/dist/index.js"]` (array form without `node`). The pnpm monorepo COPY layout (per-package node_modules) works fine under distroless — no shell is needed at runtime.

**Primary recommendation:** Plan the phase in this order: (A) Dockerfile changes + Dockerfile.migrate; (B) release.yml multi-arch + cosign/SBOM extension; (C) kustomize manifests; (D) render.yaml + embedded-worker shim; (E) test suites; (F) runbooks. The Dockerfile and embedded-worker work must land before CI integration.

---

## Standard Stack

### Core
| Library / Tool | Version | Purpose | Why Standard |
|----------------|---------|---------|--------------|
| `gcr.io/distroless/nodejs22-debian12` | latest (debian12 tag) | Runtime base for api/worker/migrate images | No shell, no package manager — minimal attack surface; supports linux/amd64 + linux/arm64 |
| `node:22-bookworm-slim` | 22-bookworm-slim | Debian-slim base for cli image | CLI needs shell for `npx playwright install`; lighter than alpine; arm64 native |
| `node:22-alpine` | 22-alpine | Build stage (unchanged) | Existing build/prod-deps stages are alpine and work correctly |
| `docker/setup-qemu-action` | v3 | QEMU for arm64 emulation in GH Actions | Required for cross-arch buildx on ubuntu-latest |
| `docker/setup-buildx-action` | v3 | Multi-arch buildx builder | Required prerequisite |
| `docker/build-push-action` | v6 | Build + push with `platforms: linux/amd64,linux/arm64` | Existing workflow already uses v6 |
| `sigstore/cosign-installer` | v3 | Install cosign in GH Actions | Official action; pins cosign binary |
| `anchore/sbom-action` | v0 (latest stable) | Install syft + generate cyclonedx-json SBOM | Official Anchore GH Action; handles syft download + caching |
| kustomize | v5.7.1 (bundled in kubectl) | k8s overlay management | kubectl v1.34.1 on dev machine includes kustomize v5.7.1 |
| kind | v0.23+ | Local k8s cluster for dev overlay smoke test | Standard tooling for local k8s; install in CI |

### Supporting
| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `node:22-alpine AS build` | (existing) | Build stage — all Dockerfiles | Keep as-is; only runtime stage changes |
| `pnpm deploy --filter @spatula/X --prod` | pnpm 9 | Extract per-package production deps | Consider for Dockerfile.migrate (only needs @spatula/db deps) |
| nginx | 1.25+ | Reverse proxy recipe (tested) | Validated recipe for reverse-proxy.md |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `gcr.io/distroless/nodejs22-debian12` | `cgr.dev/chainguard/node:22` | Chainguard images are more aggressively hardened but require a Chainguard account for some tags; distroless is simpler for OSS |
| QEMU emulation for arm64 | Native arm64 runner (paid) | Native eliminates slow better-sqlite3 rebuild under QEMU but costs more; QEMU is fine with proper Dockerfile cross-compile flags |
| `anchore/sbom-action` | `syft` CLI directly | sbom-action wraps syft with caching and standard output; equivalent result, action is simpler |

**Installation (dev/CI):**
```bash
# cosign (dev machine verification)
brew install cosign   # macOS
# Or: curl -sL https://github.com/sigstore/cosign/releases/latest/.../cosign-linux-amd64 > cosign

# kind (CI + dev)
go install sigs.k8s.io/kind@v0.23.0
# Or: brew install kind
```

**Version verification (confirmed 2026-06-10):**
- distroless nodejs22-debian12: `gcr.io/distroless/nodejs22-debian12` (supports linux/amd64, linux/arm64, arm, s390x, ppc64le)
- kustomize: v5.7.1 (bundled in kubectl v1.34.1 on this machine — CI uses kubectl install or `kustomize` standalone)

---

## Architecture Patterns

### Recommended Project Structure (new files)
```
deploy/k8s/
├── base/
│   ├── kustomization.yaml        # lists all base resources
│   ├── namespace.yaml            # spatula namespace
│   ├── api-deployment.yaml
│   ├── worker-deployment.yaml
│   ├── migrate-job.yaml          # Job (not Deployment); restartPolicy: OnFailure
│   ├── api-service.yaml
│   └── secrets.yaml              # placeholder values, clearly marked
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml    # resources: ../../base + postgres-stub.yaml + redis-stub.yaml + patches
    │   ├── postgres-stub.yaml    # Deployment + Service for in-cluster PG (postgres:16-alpine)
    │   ├── redis-stub.yaml       # Deployment + Service for in-cluster Redis (redis:7-alpine)
    │   └── patch-images.yaml     # dev image tags (e.g. :latest)
    └── prod/
        ├── kustomization.yaml    # resources: ../../base + patches; NO stub pods
        ├── patch-images.yaml     # pinned release image tags
        └── patch-resources.yaml  # higher replicas, resource requests/limits

render.yaml                       # repo root

Dockerfile.migrate                # new: distroless, db-package only
docs/runbooks/
├── backup-restore.md             # new
├── reverse-proxy.md              # new
└── hardware-sizing.md            # new
docs/support-matrix.md            # new

tests/e2e/backup/
├── round-trip.test.ts
└── vitest.config.ts              # or use root tests/vitest.config.ts
tests/upgrade/
├── migrate-and-verify.test.ts
└── vitest.config.ts
tests/config/
├── config-compat.test.ts
└── vitest.config.ts
```

---

### Pattern 1: Distroless CMD Form

**What:** distroless/nodejs22 sets `node` as its ENTRYPOINT. CMD must supply only the file path.
**When to use:** All api/worker/migrate runtime stages after switching from `node:22-alpine`.
**Critical:** The current Dockerfiles use `CMD ["node", "path"]` which works on alpine (no preset ENTRYPOINT) but would invoke `node node path` on distroless. Fix required.

```dockerfile
# WRONG for distroless (works on alpine, fails on distroless):
CMD ["node", "apps/api/dist/index.js"]

# CORRECT for distroless (entrypoint is already "node"):
CMD ["apps/api/dist/index.js"]

# For migrate (one-shot, exits after completion):
CMD ["packages/db/dist/run-migrate.js"]

# For worker:
CMD ["packages/queue/dist/worker-entrypoint.js"]
```

Source: GoogleContainerTools/distroless README — "The entrypoint of this image is set to 'node', so this image expects users to supply a path to a .js file in the CMD."

---

### Pattern 2: Multi-Stage Distroless Dockerfile

**What:** Keep existing build/prod-deps alpine stages; replace only the final runtime stage.
**When to use:** All three updated images (api, worker, migrate).

```dockerfile
# Stage 3: Distroless runtime (replaces node:22-alpine AS runtime)
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app

# Copy production node_modules (same COPY structure as existing — symlinks preserved)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
# ... (same per-package copies as today)

# Copy built output
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
# ... (same as today)

# NOTE: No RUN addgroup/adduser — distroless has a non-root user (uid 65532 "nonroot")
# Use it explicitly:
USER nonroot

EXPOSE 3000
CMD ["apps/api/dist/index.js"]
```

For the CLI (needs a shell for tools like `npx playwright`), use `node:22-bookworm-slim`:
```dockerfile
FROM node:22-bookworm-slim AS runtime
# ... same COPY structure
# Has existing adduser pattern: RUN addgroup/adduser uid 1001 still works
USER spatula
ENTRYPOINT ["node", "apps/cli/dist/index.js"]
```

Source: distroless README, verified platform support (linux/amd64 + linux/arm64).

---

### Pattern 3: Multi-Arch buildx in release.yml

**What:** Add QEMU + arm64 to existing docker job; add `migrate` to image matrix; capture digest for signing.
**When to use:** Extend existing `docker` job in `.github/workflows/release.yml`.

The `docker` job needs `id-token: write` for cosign. This must be at the **job level** (Phase 16 Pitfall #4 confirmed applies here too).

```yaml
docker:
  name: Build & Push Docker Images
  runs-on: ubuntu-latest
  needs: ci
  permissions:
    contents: read
    packages: write
    id-token: write       # required for keyless cosign signing
  strategy:
    matrix:
      include:
        - image: api
          dockerfile: Dockerfile.api
        - image: worker
          dockerfile: Dockerfile.worker
        - image: cli
          dockerfile: Dockerfile.cli
        - image: migrate
          dockerfile: Dockerfile.migrate   # new
  steps:
    - uses: actions/checkout@v4

    - name: Set up QEMU
      uses: docker/setup-qemu-action@v3   # required for arm64

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Log in to GHCR
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Install cosign
      uses: sigstore/cosign-installer@v3

    - name: Extract version
      id: version
      run: echo "version=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

    - name: Build and push (multi-arch)
      id: build
      uses: docker/build-push-action@v6
      with:
        context: .
        file: ${{ matrix.dockerfile }}
        platforms: linux/amd64,linux/arm64
        push: true
        tags: |
          ghcr.io/${{ github.repository }}/${{ matrix.image }}:${{ steps.version.outputs.version }}
          ghcr.io/${{ github.repository }}/${{ matrix.image }}:latest
        cache-from: type=gha,scope=${{ matrix.image }}
        cache-to: type=gha,mode=max,scope=${{ matrix.image }}

    - name: Sign image (keyless cosign)
      run: |
        cosign sign --yes \
          ghcr.io/${{ github.repository }}/${{ matrix.image }}@${{ steps.build.outputs.digest }}

    - name: Generate SBOM (cyclonedx-json)
      uses: anchore/sbom-action@v0
      with:
        image: ghcr.io/${{ github.repository }}/${{ matrix.image }}@${{ steps.build.outputs.digest }}
        format: cyclonedx-json
        output-file: sbom-${{ matrix.image }}.cdx.json

    - name: Attest SBOM to image
      run: |
        cosign attest --yes \
          --type cyclonedx \
          --predicate sbom-${{ matrix.image }}.cdx.json \
          ghcr.io/${{ github.repository }}/${{ matrix.image }}@${{ steps.build.outputs.digest }}

    - name: Upload SBOM as release asset
      uses: softprops/action-gh-release@v2
      with:
        files: sbom-${{ matrix.image }}.cdx.json
```

**Cache strategy:** Use `scope=${{ matrix.image }}` to separate GHA caches per image. Multi-arch with a single scope can cause cache thrash. Per-image scoping avoids this.

Source: docker/build-push-action v6 docs, nineliveszerotrust.com SBOM guide, anchore/sbom-action GitHub.

---

### Pattern 4: Cosign Verification (consumer command)

**What:** Command to document for fresh-machine smoke test (SC#3).

```bash
# Verify signature:
cosign verify \
  ghcr.io/accidentally-awesome-labs/spatula/api:1.0.0 \
  --certificate-identity-regexp='https://github\.com/accidentally-awesome-labs/spatula/\.github/workflows/release\.yml@refs/tags/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'

# Verify SBOM attestation:
cosign verify-attestation \
  ghcr.io/accidentally-awesome-labs/spatula/api:1.0.0 \
  --type cyclonedx \
  --certificate-identity-regexp='https://github\.com/accidentally-awesome-labs/spatula/\.github/workflows/release\.yml@refs/tags/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

Confidence: HIGH (verified from cosign docs and multiple real-world examples).

---

### Pattern 5: Kustomize Base + Dev Overlay + Migrate Job

**What:** k8s Job for migrations, gating api/worker startup via initContainers.
**Key insight:** kustomize `service_completed_successfully` equivalent in k8s is an **initContainer** in the api/worker Deployments that polls until the migrate Job is complete. Alternatively, the Job can use a wait-for-job pattern.

```yaml
# deploy/k8s/base/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: spatula-migrate
  annotations:
    # Rerun on upgrade via: kubectl delete job spatula-migrate && kubectl apply -k overlays/dev
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
        - name: wait-for-postgres
          image: postgres:16-alpine
          command: ['sh', '-c', 'until pg_isready -h $PGHOST -p $PGPORT; do sleep 2; done']
          env:
            - name: PGHOST
              valueFrom: { secretKeyRef: { name: spatula-secrets, key: PGHOST } }
      containers:
        - name: migrate
          image: ghcr.io/accidentally-awesome-labs/spatula/migrate:latest   # overridden by overlay
          envFrom:
            - secretRef: { name: spatula-secrets }
```

```yaml
# deploy/k8s/base/api-deployment.yaml (excerpt)
spec:
  template:
    spec:
      initContainers:
        - name: wait-for-migrate
          image: busybox:1.37
          command: ['sh', '-c', 'until kubectl get job spatula-migrate -o jsonpath="{.status.succeeded}" | grep 1; do sleep 3; done']
          # NOTE: requires RBAC to read Jobs; simpler alternative: healthcheck polling loop
```

**Simpler alternative (no RBAC needed):** Don't use an initContainer for job-completion wait. Instead, the migration job runs as a pre-install hook with sufficient backoff. The api/worker Deployments use a `startupProbe` that hits `/health/ready` (which checks DB). If the DB isn't migrated, the probe fails and the pod restarts. Combine with `initialDelaySeconds: 30` to give the migrate Job time to complete. This is simpler and matches what `service_completed_successfully` achieves in compose.

```yaml
startupProbe:
  httpGet:
    path: /health/ready
    port: 3000
  failureThreshold: 30
  periodSeconds: 10
  initialDelaySeconds: 20
```

Source: kustomize examples (kubernetes-sigs/kustomize), kubernetes.io docs.

---

### Pattern 6: Kustomize Dev Overlay — In-Cluster Stubs

```yaml
# deploy/k8s/overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - postgres-stub.yaml   # Deployment + Service: postgres:16-alpine
  - redis-stub.yaml      # Deployment + Service: redis:7-alpine
patches:
  - patch-secrets-dev.yaml   # replace placeholder secrets with dev values
  - patch-images-dev.yaml    # image tags: :latest
```

The stub Deployments use the same images as docker-compose.yml (`postgres:16-alpine`, `redis:7-alpine`) and expose them as Services with ClusterIP so the api/worker/migrate pods can reach them via `DATABASE_URL=postgresql://spatula:spatula@postgres:5432/spatula`.

---

### Pattern 7: Render Blueprint

```yaml
# render.yaml
services:
  - name: spatula-api
    type: web
    runtime: node
    plan: free
    buildCommand: pnpm install --frozen-lockfile && pnpm build
    startCommand: node apps/api/dist/server-standalone.js
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: spatula-db
          property: connectionString
      - key: REDIS_URL
        fromService:
          name: spatula-cache
          type: keyvalue
          property: connectionString
      - key: SPATULA_EMBEDDED_WORKER
        value: "1"    # D-06: runs worker in-process on free tier
      - key: NODE_ENV
        value: production
      - key: SPATULA_RENDER_FREE_TIER
        value: "1"    # for runbook caveat documentation

  - name: spatula-cache
    type: keyvalue
    plan: free
    ipAllowList:
      - source: 0.0.0.0/0
        description: Allow all (Render internal network only)

databases:
  - name: spatula-db
    plan: free
```

**Render free tier caveats to document in runbook:**
- Free Postgres: 30-day expiry (Render forum shows 30 days, not 90 — verify before publishing runbook. Earlier search result said "90 days" but Render forum is authoritative. Flag as MEDIUM confidence: verify at render.com/docs/free before writing runbook prose).
- Free web service: spins down after 15 min of inactivity; cold start ~30s.
- Free Key Value: does NOT persist to disk on restart — all Redis data lost on each restart.
- Only one free Postgres and one free Key Value per workspace.
- Background Worker type is paid-only — confirmed by Render forum (2024).

---

### Pattern 8: Embedded-Worker Mode (NEW CODE REQUIRED)

**What:** The API process must optionally start worker-entrypoint.ts's `main()` when `SPATULA_EMBEDDED_WORKER=1`.
**Scope:** Small deployment-only shim. Must NOT change the API logic path when the flag is absent.

Approach: Create `apps/api/src/embedded-worker.ts` that wraps the import and startup:

```typescript
// apps/api/src/embedded-worker.ts
export async function startEmbeddedWorker(): Promise<void> {
  const { main } = await import('@spatula/queue/worker-entrypoint');
  // OR: dynamically import packages/queue/src/worker-entrypoint.ts
  // The worker-entrypoint.ts main() registers signal handlers and runs forever.
  // In embedded mode, the API's own signal handlers already exist; coordinate shutdown.
  await main();
}
```

**Problem:** `worker-entrypoint.ts` calls `process.exit(0)` on SIGTERM, which would kill the API too. The embedded shim needs `worker-entrypoint.ts` to expose a `start()` function that returns a shutdown handle instead of registering its own process exit. This is a small but real refactor of `worker-entrypoint.ts`.

**Recommended approach:** Add `startWorker(opts: { onShutdown?: () => void }): Promise<{ shutdown: () => Promise<void> }>` export to `packages/queue/src/worker-entrypoint.ts`, keeping the `main()` function as the standalone entry. In embedded mode, the API calls `startWorker()` and wires its shutdown into the API's own graceful-shutdown flow (`executeShutdown` in `shutdown.ts`).

**Risk level: MEDIUM.** The code change is small (~50 lines) but touches the worker lifecycle. Requires a test that the API starts and the worker heartbeat registers when `SPATULA_EMBEDDED_WORKER=1`.

---

### Pattern 9: Test Suite Structure

**backup round-trip test (`tests/e2e/backup/round-trip.test.ts`):**
```
Pattern: Same as DSR deletion test (no HTTP fixture; direct DB/ContentStore calls)
1. Seed: INSERT rows across all tables + ContentStore.store() calls
2. Capture: pg_dump --no-owner --no-acl (via child_process.execFileSync) → buffer
3. ContentStore snapshot: enumerate content_store table (SELECT key, content FROM content_store)
4. Restore: DROP + RECREATE test DB, psql < dump; re-insert content_store rows
5. Assert: row counts match; SELECT COUNT(*) per table; ContentStore.retrieve() parity
6. Gate: requires real Postgres (skip if DATABASE_URL absent) — follow DSR pattern
```

**ContentStore backup note:** The `ContentStore` interface has no `listKeys()` method. The backup test must enumerate content by querying the `content_store` table directly (via Drizzle) and calling `retrieve()` for each row. This is correct for the Postgres-backed store. For S3/Local stores, the backup test is explicitly out of scope for v1 (runbook documents the pg_dump + DB-enumeration approach; S3 uses native bucket replication tooling).

**upgrade test (`tests/upgrade/migrate-and-verify.test.ts`):**
```
1. Create a fresh test DB
2. Apply 0000_v1_baseline.sql directly (psql or raw SQL execution)
   — This simulates "a v1.0 database"
3. Run run-migrate.ts against it (applies any v1.1+ incremental migrations)
4. Assert: __drizzle_migrations_oss table has expected migration hashes
5. Assert: SELECT 1 from each expected table (schema-level smoke)
6. No data seeding needed for schema-level test
```

**config-compat test (`tests/config/config-compat.test.ts`):**
```
1. Write a v1.0 spatula.yaml fixture to a temp dir
2. Call parseProjectYamlFile (from @spatula/core) on it
3. Assert: no throw; required fields parsed correctly
4. The test is purely in-process — no DB, no HTTP
```

Source: tests/e2e/dsr/deletion/round-trip.test.ts pattern; packages/core/src/diagnostics confirming parseProjectYamlFile location.

---

### Anti-Patterns to Avoid

- **Double-invocation in distroless:** `CMD ["node", "dist/index.js"]` on distroless calls `node node dist/index.js` because distroless has `ENTRYPOINT ["node"]` preset. Use `CMD ["dist/index.js"]` only.
- **Using USER spatula (uid 1001) in distroless:** distroless uses `nonroot` (uid 65532) or `root`. The alpine-based `adduser` stanza creates uid 1001 but distroless images don't have that user. Use `USER nonroot` (distroless) vs `USER spatula` (Debian-slim cli).
- **Shared GHA cache scope across matrix images:** Using a single `scope` for all four images in the multi-arch matrix causes cache eviction races. Scope caches per image.
- **cosign signing before image push:** cosign requires the image digest to exist in the registry. Always sign AFTER `build-push-action` completes and captures `${{ steps.build.outputs.digest }}`.
- **id-token: write at workflow level:** Already learned in Phase 16 — must be at job level for the docker job. The `publish-npm` job already has it at job level; the `docker` job currently does NOT have it and needs it added.
- **Render worker type on free plan:** `type: worker` requires a paid Render plan. The blueprint must use `type: web` for the single free service.
- **better-sqlite3 arm64 under QEMU emulation:** better-sqlite3 is in `@spatula/db` (core dependency). Cross-compiling native addons under QEMU is very slow (~10–20min) and can produce incorrect binaries if the build system isn't properly set up. Solution: use `--platform=$TARGETPLATFORM` ARG in the build stage and ensure pnpm's `--prod` install runs native rebuild for the target arch. The `node:22-alpine AS build` stage with QEMU emulation will compile correctly but slowly. For CI speed, consider pinning better-sqlite3's pre-built binary fetch instead of compilation, but this is optional optimization.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Container supply chain signing | Custom GPG key infrastructure | cosign keyless (OIDC → Fulcio → Rekor) | No key management, transparent log, follows Sigstore standard |
| SBOM generation | Manual dependency enumeration | anchore/sbom-action (syft) | Handles node_modules tree, produces spec-valid cyclonedx-json |
| Multi-arch builds | Separate per-arch CI jobs with manual manifest merge | docker/build-push-action with platforms: linux/amd64,linux/arm64 | Handles manifest list creation automatically |
| k8s environment management | Manual YAML duplication | kustomize overlays | Shipped with kubectl; zero extra deps |
| Render Postgres connection | Manual URL construction | `fromDatabase: { property: connectionString }` | Render handles URL rotation on plan changes |

---

## Common Pitfalls

### Pitfall 1: distroless CMD Double-Node Invocation
**What goes wrong:** `node apps/api/dist/index.js` works on alpine (no preset ENTRYPOINT) but fails on distroless with "Error: Cannot find module 'apps/api/dist/index.js'" because the effective command becomes `node node apps/api/dist/index.js`.
**Why it happens:** distroless Node images have `ENTRYPOINT ["node"]` baked in; adding `node` to CMD duplicates it.
**How to avoid:** Use `CMD ["apps/api/dist/index.js"]` (single-element array, path only).
**Warning signs:** Container exits immediately with a node module resolution error referencing the first argument as a file path.

### Pitfall 2: Worker Lifecycle Conflict in Embedded Mode
**What goes wrong:** `worker-entrypoint.ts`'s `main()` registers its own `process.on('SIGTERM', ...)` handlers and calls `process.exit(0)`. In embedded mode, these conflict with the API server's own shutdown handlers.
**Why it happens:** worker-entrypoint.ts was designed as a standalone process.
**How to avoid:** Refactor worker-entrypoint.ts to expose `startWorker()` that returns a `{ shutdown() }` handle. Wire it into `apps/api/src/shutdown.ts`'s `executeShutdown()`.
**Warning signs:** API container exits silently on SIGTERM before HTTP connections drain; worker shutdown races with API shutdown.

### Pitfall 3: cosign Signing Before Push Digest is Available
**What goes wrong:** Attempting to sign `image:tag` (by tag) instead of `image@digest` can sign a different layer if the tag is updated concurrently.
**Why it happens:** Tag-based signing is a TOCTOU vulnerability.
**How to avoid:** Always use `${{ steps.build.outputs.digest }}` (the immutable digest output from build-push-action) as the signing target.
**Warning signs:** cosign warns "signing by tag is not recommended".

### Pitfall 4: id-token:write Missing on docker Job
**What goes wrong:** cosign fails with "error getting identity token: 'no ID token received'" — no useful error message about permissions.
**Why it happens:** The docker job currently has `permissions: { contents: write, packages: write }` at the workflow level; job-level override is needed for OIDC.
**How to avoid:** Add `id-token: write` to the `docker` job's `permissions` block specifically (not workflow-level, per Phase 16 Pitfall #4 precedent).
**Warning signs:** cosign step fails on the OIDC token fetch step.

### Pitfall 5: Render Free Postgres vs. Key Value Persistence
**What goes wrong:** Redis Key Value data (BullMQ job queues, ws-token state) is wiped on every Render free instance restart. Jobs submitted to BullMQ are lost on restart.
**Why it happens:** Free Render Key Value instances do NOT persist to disk between restarts (unlike paid instances).
**How to avoid:** Document clearly in runbook; frame blueprint as "demo/try-it" only. The API gracefully handles empty queues on startup.
**Warning signs:** Users report jobs disappearing after a Render sleep/restart cycle.

### Pitfall 6: kind Cluster Timing — Migrate Job vs. API Startup
**What goes wrong:** `kubectl apply -k deploy/k8s/overlays/dev` succeeds but the api pod is in CrashLoopBackOff because the migrate job hasn't finished yet.
**Why it happens:** k8s Deployments and Jobs start concurrently unless ordering is enforced.
**How to avoid:** Use a `startupProbe` on the api/worker Deployments that polls `/health/ready` (which checks DB). If DB isn't migrated, the ready probe fails and the pod restarts. Set `initialDelaySeconds: 20` to give the migrate Job a head start.
**Warning signs:** api pod logs show Drizzle migration table not found or schema mismatch errors on first start.

### Pitfall 7: better-sqlite3 ARM64 Cross-Compile in QEMU
**What goes wrong:** The arm64 build of `better-sqlite3` takes 15–25 minutes under QEMU emulation on a GitHub Actions ubuntu-latest runner.
**Why it happens:** QEMU emulates the full CPU, making native C++ compilation extremely slow.
**How to avoid:** Use Docker's `--build-arg BUILDPLATFORM` and native-target cross-compile flags, OR accept the slow build for now (it will be correct if slow). Do NOT use `--platform=$BUILDPLATFORM` for the prod-deps stage if you want native arm64 binaries.
**Warning signs:** CI step "pnpm install --frozen-lockfile --prod" takes >15 min on the arm64 pass.

---

## Code Examples

### Dockerfile.migrate (new file, distroless)
```dockerfile
# Dockerfile.migrate — one-shot migration runner
# Uses distroless nodejs22-debian12 with db-package deps only.

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
COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
RUN pnpm --filter @spatula/db... run build

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

FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/package.json ./
USER nonroot
CMD ["packages/db/dist/run-migrate.js"]
```

### Vitest Config for New Test Suites
The root `tests/vitest.config.ts` already includes `tests/e2e/**/*.test.ts`. New test files placed under `tests/e2e/backup/` will be picked up automatically. For `tests/upgrade/` and `tests/config/`, either extend the root config's `include` array or add sibling vitest configs:

```typescript
// tests/upgrade/vitest.config.ts (or add 'tests/upgrade/**' to root config include)
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
const root = resolve(__dirname, '../..');
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/upgrade/**/*.test.ts'],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@spatula/db': resolve(root, 'packages/db/src/index.ts'),
      '@spatula/core': resolve(root, 'packages/core/src/index.ts'),
      '@spatula/queue': resolve(root, 'packages/queue/src/index.ts'),
      '@spatula/shared': resolve(root, 'packages/shared/src/index.ts'),
    },
  },
});
```

Add `"test:upgrade"` and `"test:config"` scripts to root `package.json`.

### spatula doctor — 9 Checks Confirmed
doctor command runs: 5 system checks (node-version, docker, llm-provider, playwright, env-file) + 4 server checks (postgres, redis, api-server, migrations) = 9 total. SC#1 asserts 9/9 green from inside the cluster. In k8s, the cli image must be run as a Job or ephemeral container with access to `DATABASE_URL`, `REDIS_URL`, and `API_URL` env vars. `spatula doctor` will pass when: (a) api pod is running and healthy, (b) postgres reachable, (c) redis reachable, (d) migrations applied. The doctor `node-version` check always passes (Node 22 in image). `playwright` is warn not fail (not installed in api/worker pods — that is expected). Net: 9/9 green is achievable.

---

## Runtime State Inventory

Phase 19 is not a rename/refactor — no runtime state inventory required.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker / buildx | Multi-arch image builds | ✓ | Docker 29.3.0, buildx v0.32.1 | — |
| kubectl + kustomize | k8s overlay testing | ✓ | kubectl v1.34.1, kustomize v5.7.1 | — |
| kind | Dev overlay smoke test (local) | ✗ | — | Install via `brew install kind` or CI step |
| cosign | Image signing verification | ✗ | — | Install via `brew install cosign` or CI action |
| pg_dump | Backup test + runbook | ✓ | pg_dump (PostgreSQL) 14.23 | — |
| redis-cli | Backup runbook | ✓ | redis-cli 8.8.0 | — |
| Node 26 | Build/test | ✓ | v26.0.0 | — |

**Missing dependencies with no fallback (must install):**
- `kind` — required to run `kubectl apply -k deploy/k8s/overlays/dev` locally (CI will install via `go install` or the kindest/kind GH Action).
- `cosign` — required for local verification smoke tests; install on dev machine before SC#3 verification.

**Missing dependencies with fallback:**
- None blocking for CI; GitHub Actions installs all required tools via dedicated steps.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.1.0 |
| Config file | `tests/vitest.config.ts` (root) — backup tests added to include; upgrade+config tests get sibling configs |
| Quick run command | `pnpm test:e2e` (covers backup) / `vitest run --config tests/upgrade/vitest.config.ts` |
| Full suite command | `pnpm test:e2e && vitest run --config tests/upgrade/vitest.config.ts && vitest run --config tests/config/vitest.config.ts` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DEPLOY-01 | kustomize base + overlays apply cleanly on kind | smoke | `kubectl apply -k deploy/k8s/overlays/dev && kubectl wait --for=condition=Available deployment/spatula-api --timeout=120s` | ❌ Wave 0 (CI job: `.github/workflows/k8s-smoke.yml`) |
| DEPLOY-02 | render.yaml is valid blueprint YAML | lint | `python3 -c "import yaml; yaml.safe_load(open('render.yaml'))"` | ❌ Wave 0 |
| DEPLOY-03 | Images build multi-arch + run | build | CI: `docker buildx build --platform linux/amd64,linux/arm64 --no-push -f Dockerfile.api .` | ❌ Wave 0 (CI job) |
| DEPLOY-04 | cosign verify succeeds on all 4 images | smoke | `cosign verify ghcr.io/.../api@<digest> --certificate-identity-regexp=... --certificate-oidc-issuer=...` | ❌ Wave 0 (post-release manual) |
| DEPLOY-05 | backup→restore round-trip: row-count + content-hash parity | e2e | `vitest run --config tests/vitest.config.ts tests/e2e/backup/round-trip.test.ts` | ❌ Wave 0 |
| DEPLOY-06 | upgrade.md version template exists | grep | `grep -q "## Version-to-Version Migration Template" docs/runbooks/upgrade.md` | ❌ Wave 0 (doc edit) |
| DEPLOY-07 | nginx config reverse-proxies to spatula api | e2e | `nginx -t -c docs/runbooks/nginx.conf && curl -f http://localhost/health/live` (manual or CI with nginx service) | ❌ Wave 0 |
| DEPLOY-08 | min-version matrix CI passes | CI | `.github/workflows/support-matrix.yml` with node 22 × pg 14/15/16 × redis 7 | ❌ Wave 0 (CI job) |
| DEPLOY-09 | hardware-sizing.md has measured table | manual | `grep -q "1000 pages" docs/runbooks/hardware-sizing.md` + human review | ❌ Wave 0 (live measurement) |
| DEPLOY-10 | v1.0 DB → v1.x migration → runtime verified | integration | `vitest run --config tests/upgrade/vitest.config.ts` | ❌ Wave 0 |
| DEPLOY-11 | v1.0 spatula.yaml parses on v1.1 runtime | unit | `vitest run --config tests/config/vitest.config.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm build && pnpm typecheck` (no new tests until test files exist)
- **Per wave merge:** full test suite + `kubectl apply -k deploy/k8s/overlays/dev` smoke
- **Phase gate:** All 11 DEPLOY-xx validated (automated where possible; manual note for DEPLOY-09 + DEPLOY-04)

### Heavy Test CI Cadence (Claude's Discretion)
Follow the `adversarial-llm.yml` precedent: the new `tests/e2e/backup/`, `tests/upgrade/`, `tests/config/` lanes + the min-version matrix should run:
- **on-release** (trigger: `on: push: tags: ['v*']`)
- **nightly** (trigger: `on: schedule: [{cron: '0 2 * * *'}]`)
- NOT on every PR (to avoid adding DB-heavy jobs to the standard PR gate)

A lightweight smoke subset (config-compat only — pure in-process, no DB) may run on PR.

### Wave 0 Gaps
- [ ] `tests/e2e/backup/round-trip.test.ts` — covers DEPLOY-05
- [ ] `tests/upgrade/migrate-and-verify.test.ts` — covers DEPLOY-10
- [ ] `tests/config/config-compat.test.ts` — covers DEPLOY-11
- [ ] `tests/upgrade/vitest.config.ts` — shared config
- [ ] `tests/config/vitest.config.ts` — shared config
- [ ] `.github/workflows/k8s-smoke.yml` — covers DEPLOY-01 (kind cluster smoke)
- [ ] `.github/workflows/support-matrix.yml` — covers DEPLOY-08
- [ ] `Dockerfile.migrate` — new file
- [ ] `apps/api/src/embedded-worker.ts` — Render D-06 shim
- [ ] `packages/queue/src/worker-entrypoint.ts` refactor — export `startWorker()` for embedded mode
- [ ] `deploy/k8s/` tree — net-new
- [ ] `render.yaml` — net-new

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| GPG key-based container signing | Keyless cosign (OIDC → Fulcio → Rekor) | ~2022, now standard | No key management; verification requires `cosign verify` with identity regexp |
| distroless/nodejs16 or /nodejs18 | `gcr.io/distroless/nodejs22-debian12` | 2024 | Node 22 LTS support; debian12 base |
| `node:X-alpine` for runtime | distroless for server images | Industry trend 2023-2025 | ~60% smaller image; no shell attack surface |
| `type: redis` in render.yaml | `type: keyvalue` | 2024 | `redis` alias still works but `keyvalue` is current |

**Deprecated/outdated:**
- `type: redis` in render.yaml: still accepted as alias but `type: keyvalue` is the canonical form.
- Background worker free plan on Render: was briefly available; removed. Use `type: web` with embedded worker for free tier.

---

## Open Questions

1. **Render free Postgres expiry: 30 days or 90 days?**
   - What we know: Render forum says "30 days" in 2024; the CONTEXT.md decision (D-07) says "90-day expiry."
   - What's unclear: The official render.com/docs/free page is authoritative and should be checked at implementation time.
   - Recommendation: Runbook author must check render.com/docs/free before publishing the caveat. Write it as a variable with a link to the official docs rather than hard-coding the number.

2. **kind cluster k8s smoke test: where does it run (CI or manual)?**
   - What we know: kind is not installed on the dev machine; CI ubuntu-latest runners support kind via the kindest/kind GH Action.
   - What's unclear: Should DEPLOY-01 smoke run on every PR, on-release, or manual-only?
   - Recommendation: On-release + nightly, same as the heavy-test cadence decision. A manual `make kind-smoke` for developers.

3. **better-sqlite3 arm64 QEMU build time**
   - What we know: QEMU-emulated arm64 C++ compilation is slow (15–25 min range).
   - What's unclear: Whether the current `prod-deps` stage actually compiles better-sqlite3 from source or downloads a prebuilt binary via better-sqlite3's `install.js`.
   - Recommendation: Inspect `packages/db/package.json` preinstall scripts; if it downloads prebuilt binaries, QEMU speed is not an issue. Verify during Wave 0.

4. **Playwright in CLI docker image: is it needed?**
   - What we know: `Dockerfile.cli` is Debian-slim (not distroless) and the CLI uses Playwright for crawling.
   - What's unclear: Does the CLI docker image need `npx playwright install` baked in? Or is the CLI container purely for the TUI/remote-commands mode?
   - Recommendation: Check if the CLI image is expected to crawl directly. If `spatula run` in CLI mode spawns Playwright, the image needs browsers installed. If it only sends jobs to the api (remote mode), it doesn't. This affects image size significantly (~600MB for Playwright chromium).

---

## Sources

### Primary (HIGH confidence)
- GoogleContainerTools/distroless README — distroless nodejs22-debian12 tag, ENTRYPOINT behavior, platform support
- kubernetes-sigs/kustomize Context7 docs — base/overlay directory structure, overlay patterns
- docker/build-push-action docs (docs.docker.com) — multi-platform, QEMU, cache strategy
- sigstore/cosign Context7 docs — keyless sign, attest, verify CLI syntax
- Existing project source (`Dockerfile.api/worker/cli`, `release.yml`, `worker-entrypoint.ts`, `server.ts`, `doctor.ts`, `system-checks.ts`, `server-checks.ts`) — all read directly

### Secondary (MEDIUM confidence)
- Render Blueprint Spec (render.com/docs/blueprint-spec, fetched) — render.yaml schema, free tier
- Render forum (render.discourse.group) — background worker not available on free plan (confirmed 2024)
- nineliveszerotrust.com SBOM guide — exact GitHub Actions YAML for cosign sign + attest + sbom-action
- anchore/sbom-action (github.com/anchore/syft/wiki/attestation) — cyclonedx attestation syntax

### Tertiary (LOW confidence — verify before use)
- Render free Postgres expiry duration (90 days vs 30 days) — contradictory sources; check render.com/docs/free at implementation time

---

## Metadata

**Confidence breakdown:**
- Distroless CMD form + USER nonroot: HIGH — verified from distroless README
- Multi-arch buildx workflow: HIGH — verified from official Docker docs + existing release.yml pattern
- cosign keyless signing steps: HIGH — verified from multiple real-world examples + cosign Context7 docs
- kustomize overlay structure: HIGH — verified from kustomize Context7 docs + kubernetes.io
- Render blueprint schema: MEDIUM — fetched from render.com/docs but free tier caveats may drift
- Embedded-worker gap: HIGH — confirmed by grepping apps/api/src/ (no SPATULA_EMBEDDED_WORKER or equivalent found)
- better-sqlite3 arm64 slow build: MEDIUM — general knowledge; specific build duration depends on whether prebuilt binaries are used

**Research date:** 2026-06-10
**Valid until:** 2026-08-10 (tools are fairly stable; Render free tier policies may change faster — verify at implementation time)
