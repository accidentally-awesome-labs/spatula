# Phase 19: Deployment & Self-Host Excellence - Context

**Gathered:** 2026-06-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a first-class self-host experience across **docker-compose, Kubernetes (kustomize), and Render (PaaS)**:
supply-chain-signed multi-arch container images with SBOMs, an exercised backup/upgrade/config test suite,
a measured hardware-sizing baseline, and the self-host runbook set.

In scope (DEPLOY-01..11):

- `deploy/k8s/` kustomize base + dev/prod overlays (api, worker, migrate Job)
- `render.yaml` Render blueprint (free-tier-deployable)
- Multi-arch (`linux/amd64` + `linux/arm64`) images via buildx; distroless api/worker/migrate, Debian-slim cli
- cosign signing + cyclonedx-json SBOM for all four images (api/worker/migrate/cli)
- Runbooks: `backup-restore.md`, `reverse-proxy.md` (nginx tested; traefik/caddy disclaimer stubs), `hardware-sizing.md`; extend existing `upgrade.md`
- `docs/support-matrix.md` + min-version CI matrix (Node 22+, PG 14+, Redis 7+, macOS/Linux/WSL)
- `tests/e2e/backup/`, `tests/upgrade/`, `tests/config/`

Out of scope (clarifies the boundary): the docs **site** (Phase 20), full CI **topology**/devcontainer (Phase 21),
release-workflow **launch polish** + post-publish smoke (Phase 22), a first-party **Helm chart** (deferred to v1.1).
Discussion below clarifies HOW within this fixed boundary — no new capabilities.

</domain>

<decisions>
## Implementation Decisions

### Hardware-sizing baseline (DEPLOY-09)

- **D-01:** Measure on a **single defined cloud VM class** (researcher picks a representative, reproducible instance — e.g. ~4 vCPU / 8 GB / SSD — and names it explicitly in the table). A laptop is rejected as a server-sizing proxy.
- **D-02:** The LLM cost-per-page column covers **all three routing tiers** (fast / primary / smart) — one row each — so self-hosters see the smart-routing cost spread.
- **D-03:** **Full live measurement this phase.** Run the 1k-page crawl **live, once per tier**, on the one defined VM (3 live 1k-page runs total — real LLM spend + crawl wall-clock). The result is a genuinely _measured_ table, not synthetic. Document the harness + assumptions so self-hosters can re-run for their own hardware.

### Container image signing & SBOM (DEPLOY-04)

- **D-04:** **Keyless cosign** — GitHub Actions OIDC → Fulcio short-lived cert → signature in the public **Rekor** transparency log. No private signing key to store or rotate (consistent with the OIDC trusted-publishing already used for npm in `release.yml`). Verification documented via `cosign verify --certificate-identity ... --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
- **D-05:** SBOM (cyclonedx-json) attached **both ways**: uploaded as a **GitHub release asset** (satisfies SC#3 literal wording) **and** attached to each image via **`cosign attest`** (in-toto SBOM attestation in Rekor — travels with the image, verifiable in-pipeline).

### Render blueprint (DEPLOY-02)

- **D-06:** Render free tier has **no Background Worker type** (paid only). The blueprint runs the **worker in-process with the API** on one free Web Service, behind an env flag (e.g. an embedded-worker mode). This reliably satisfies SC#2's "full stack reachable on the assigned URL" on a genuine free-tier account. The runbook must state clearly that **production splits api and worker** into separate services.
- **D-07:** Provision **Render-managed free Postgres + free Key Value (Redis)** in the blueprint — one-click, self-contained, zero external setup. The runbook documents the free-tier caveats: **Postgres 90-day expiry** and **web-service spin-down on inactivity**. (This is a try-it/demo blueprint, not a prod recommendation.)

### Kubernetes kustomize (DEPLOY-01)

- **D-08:** Secrets via a **plain `Secret` manifest with clearly-marked placeholder values** in the base, replaced by operators via `kubectl create secret` or a gitignored overlay. No mandatory cluster dependencies (lowest barrier). `external-secrets` and `sealed-secrets` are documented as **upgrade paths**, not requirements.
- **D-09:** **Dev overlay ships throwaway in-cluster Postgres + Redis pods** so `kubectl apply -k deploy/k8s/overlays/dev` comes up healthy and self-contained on a fresh `kind` cluster (satisfies SC#1's "external Postgres + Redis stubs"). **Prod overlay strips the stubs** and references operator-supplied managed Postgres/Redis ("users bring their own"), and sets prod resource requests/replicas + pinned image tags.

### Claude's Discretion

- **Migrate image topology:** default to a **dedicated `Dockerfile.migrate`** (distroless, db-package deps only → smaller, cleaner k8s Job and a 4th independently-signed image per SC#3). Acceptable alternative if simpler: reuse the api image with a command override (current `docker-compose.prod.yml` approach) while still tagging/signing it as the `migrate` image. Planner decides; SC#3 requires four signed images either way.
- **Heavy-test CI cadence:** default the new `tests/e2e/backup/`, `tests/upgrade/`, `tests/config/` lanes + the min-version matrix (DEPLOY-08) to run **on-release + nightly** (not on every PR) to bound CI cost/time; a fast subset may run on PR. Full CI topology is Phase 21 — keep this phase's wiring minimal and additive.
- Distroless base image selection (e.g. `gcr.io/distroless/nodejs22`), buildx caching strategy, exact `kind`/Render smoke-test harness, runbook prose structure, time-to-restore estimate methodology.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & acceptance (read first)

- `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md` §6-5 — authoritative deployment deliverables list + acceptance criteria (kustomize-not-Helm, distroless bases, nginx-tested + traefik/caddy disclaimer stubs, external PG/Redis in prod, Helm-limitation note for ROADMAP v1.1).
- `.planning/ROADMAP.md` "Phase 19" detail — the 5 success criteria (kind apply + `spatula doctor` 9-green; render.yaml free-tier; cosign verify amd64+arm64 + SBOM on release; backup/upgrade/config tests; runbook set).
- `.planning/REQUIREMENTS.md` DEPLOY-01..DEPLOY-11 — the 11 acceptance requirements this phase closes.

### Migration / upgrade policy (build on, do not re-decide)

- `docs/runbooks/upgrade.md` — **already exists** (Phase 15): no-migration-downgrade + expand-contract-only policy. DEPLOY-06 extends it with a version-to-version migration template; DEPLOY-10's `tests/upgrade/` enforces it.
- `docs/private-contract.md` — two-journal model (`__drizzle_migrations_oss` vs `__drizzle_migrations_saas`) + Residual Risk Register. OSS deploy touches only the oss journal; the upgrade/migration tests must respect this.

### Existing deployment assets to extend (not rebuild)

- `Dockerfile.api`, `Dockerfile.worker`, `Dockerfile.cli` — multi-stage `node:22-alpine`, non-root user (uid 1001). Phase 19 must: add `linux/arm64` (multi-arch buildx), switch api/worker(/migrate) to **distroless** + cli to **Debian-slim**, and add a migrate image.
- `docker-compose.yml`, `docker-compose.prod.yml` — current full-stack reference: one-shot `migrate` (reuses api image, `node packages/db/dist/run-migrate.js`), healthchecks, `service_completed_successfully` gating. The k8s migrate Job + Render blueprint should mirror this ordering.
- `.github/workflows/release.yml` — current release pipeline: builds api/worker/cli → GHCR on `v*` tags, single-arch, **no cosign, no SBOM**. Phase 19 extends the `docker` job with buildx multi-arch (+migrate image), keyless cosign sign + `cosign attest` SBOM, and release-asset upload.
- `packages/db/src/run-migrate.ts` (built: `packages/db/dist/run-migrate.js`) — migration entrypoint for the migrate image/Job.
- `packages/queue/src/worker-entrypoint.ts` (built: `packages/queue/dist/worker-entrypoint.js`) — worker entrypoint; the Render in-process/embedded-worker mode (D-06) wires this alongside the api server.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **Three Dockerfiles** (`Dockerfile.api/worker/cli`): multi-stage build → prod-deps → runtime, non-root uid 1001. Reuse the build/prod-deps stages; swap only the final runtime base for distroless/Debian-slim and add `--platform` matrix.
- **`docker-compose.prod.yml`**: encodes the correct service dependency ordering (postgres healthy → migrate completes → api/worker start). The k8s manifests (initContainer or migrate Job + readiness gating) and Render blueprint should preserve this ordering.
- **`run-migrate.js`** one-shot migrator and **`worker-entrypoint.js`**: the deployable process entrypoints — no new orchestration code needed, just packaging/wiring.
- **`release.yml` docker job**: an existing buildx + GHCR + matrix-over-images pattern to extend (add `migrate` row, `platforms: linux/amd64,linux/arm64`, cosign/attest steps), not rewrite.
- **`spatula doctor`** (9-check diagnostics, Wave 4-1): SC#1 asserts all 9 green from inside the cluster — reuse as the k8s health gate.

### Established Patterns

- **Test-config convention:** root-level test suites use Node-builtin `http.Server` fixtures (Phase 15/16 `tests/carveout`, `tests/private-contract`) instead of adding `@hono/node-server` to the workspace root. New `tests/{e2e/backup,upgrade,config}/` should follow this if they need an HTTP surface.
- **CI live-vs-mock split:** `SPATULA_LIVE_LLM` gates real-LLM tests (`it.skipIf(LIVE)`); contributor-fork CI passes without `OPENROUTER_API_KEY`. The live sizing-baseline measurement (D-03) must live behind this gate / be a manual or main-only job — never block fork PRs.
- **Pinned-model CI lane** (Phase 18 `adversarial-llm.yml`): a precedent for a path-triggered + daily-cron live-LLM job — a good model for the heavy/live Phase 19 lanes.

### Integration Points

- `.github/workflows/release.yml` `docker` job — primary integration site for DEPLOY-03/04 (multi-arch, migrate image, cosign, SBOM).
- New top-level `deploy/k8s/` tree (DEPLOY-01) and repo-root `render.yaml` (DEPLOY-02) — net-new.
- New `docs/runbooks/{backup-restore,reverse-proxy,hardware-sizing}.md` + `docs/support-matrix.md`; extend existing `docs/runbooks/upgrade.md`.
- New `tests/e2e/backup/`, `tests/upgrade/`, `tests/config/` under the existing root `tests/` tree (sibling to `tests/e2e/`, `tests/carveout`, `tests/isolation`).
- Render embedded-worker mode (D-06) needs the api process to optionally boot `worker-entrypoint` logic behind an env flag — researcher to confirm whether such a mode exists or must be added (small, deployment-only).

</code_context>

<specifics>
## Specific Ideas

- Sizing table must be **genuinely measured** (live runs), not estimated — the user explicitly chose full live measurement over a synthetic estimate.
- cosign verification UX should be **self-hoster-runnable from a fresh machine** (keyless verify command documented), matching SC#3's fresh-machine smoke test.
- Render blueprint is framed as a **try-it/demo** path with honest free-tier caveats, distinct from the prod-grade k8s/compose paths.

</specifics>

<deferred>
## Deferred Ideas

- **First-party Helm chart** — explicitly a v1.1 item per spec §6-5; kustomize-only at v1. Add the "Helm chart — community-contributed welcome in v1.x; first-party targeted for v1.1" note to `ROADMAP.md` v1.1 section (this note IS in Phase 19 scope; the chart itself is not).
- **traefik / caddy reverse-proxy recipes** — ship as community-contributed stubs with a prominent "not first-party tested" disclaimer (nginx is the only tested recipe this phase). Promotion to tested recipes is a future community-PR path.
- **Full CI topology + devcontainer** (preflight/unit/contract/e2e/audit/release split) — Phase 21. Phase 19 only adds the minimal additive lanes it owns (min-version matrix + heavy-test triggers).
- **Release-workflow launch polish + post-publish smoke + cosign-in-launch-runbook** — Phase 22. Phase 19 ships the signing _infrastructure_; Phase 22 polishes/operationalizes it.
- **Reviewed todos (not folded):** none — no pending todos matched this phase.

</deferred>

---

_Phase: 19-deployment-self-host-excellence_
_Context gathered: 2026-06-10_
