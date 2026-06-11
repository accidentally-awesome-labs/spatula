# Phase 19: Deployment & Self-Host Excellence - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-10
**Phase:** 19-deployment-self-host-excellence
**Areas discussed:** Hardware-sizing baseline, Container image signing & SBOM, Render free-tier blueprint, Kubernetes secrets & overlays

---

## Gray-area selection

| Option           | Description                                                         | Selected |
| ---------------- | ------------------------------------------------------------------- | -------- |
| Sizing baseline  | Reference hardware + tiers + measure-now vs methodology (DEPLOY-09) | ✓        |
| Image signing    | cosign mode + SBOM attach location (DEPLOY-04)                      | ✓        |
| Render free-tier | Worker/DB/Redis mapping on Render free tier (DEPLOY-02)             | ✓        |
| k8s secrets      | Secret injection strategy + overlay split (DEPLOY-01)               | ✓        |

**User's choice:** All four areas selected.

---

## Hardware-sizing baseline

### Q1 — Reference hardware

| Option            | Description                                                           | Selected |
| ----------------- | --------------------------------------------------------------------- | -------- |
| Defined cloud VM  | Single named cloud instance class; prod-representative + reproducible | ✓        |
| M-series Mac 16GB | Matches spec §6-7 fresh-machine; laptop is a weak server proxy        |          |
| Both rows         | Laptop (dev) + cloud (prod); widest but doubles measurement cost      |          |

### Q2 — Models in cost table

| Option             | Description                            | Selected |
| ------------------ | -------------------------------------- | -------- |
| All 3 tiers        | fast / primary / smart, one row each   | ✓        |
| Primary + smart    | Only the extraction-heavy tiers        |          |
| Default model only | Single row for the setup-default model |          |

### Q3 — Measurement approach

| Option              | Description                                 | Selected |
| ------------------- | ------------------------------------------- | -------- |
| Methodology + 1 run | Document harness, run once to populate      |          |
| Full live matrix    | Run hardware × model combos live this phase | ✓        |
| Synthetic estimate  | Estimate from token counts × pricing        |          |

**User's choice:** Defined cloud VM · All 3 tiers · Full live measurement.
**Notes:** Single VM × 3 tiers resolves to 3 live 1k-page crawls on the one VM class. Researcher names a representative reproducible instance.

---

## Container image signing & SBOM

### Q1 — cosign mode

| Option               | Description                                           | Selected |
| -------------------- | ----------------------------------------------------- | -------- |
| Keyless (OIDC+Rekor) | GitHub OIDC → Fulcio → public Rekor log; no key mgmt  | ✓        |
| Key-pair (private)   | Stored private key; no public log but rotation burden |          |

### Q2 — SBOM attach location

| Option               | Description                                                  | Selected |
| -------------------- | ------------------------------------------------------------ | -------- |
| Release + OCI        | GitHub release asset AND cosign attest (in-toto attestation) | ✓        |
| Release asset only   | Literal SC#3 wording; simplest                               |          |
| OCI attestation only | Travels with image; less discoverable                        |          |

**User's choice:** Keyless cosign · SBOM as release asset + OCI attestation.
**Notes:** Consistent with the OIDC trusted-publishing already wired for npm in release.yml.

---

## Render free-tier blueprint

### Q1 — Worker representation (free tier has no Background Worker type)

| Option                 | Description                                            | Selected |
| ---------------------- | ------------------------------------------------------ | -------- |
| In-process with API    | One free Web Service runs api + worker behind env flag | ✓        |
| Separate free web svc  | Worker as own free Web Service + health-port shim      |          |
| Paid Background Worker | Honest prod blueprint, but not free-tier               |          |

### Q2 — Postgres + Redis provisioning

| Option                | Description                                               | Selected |
| --------------------- | --------------------------------------------------------- | -------- |
| Render-managed free   | Free Postgres (90-day expiry) + free Key Value; one-click | ✓        |
| External via env vars | Operator-supplied DATABASE_URL/REDIS_URL                  |          |

**User's choice:** Worker in-process with API · Render-managed free PG + Key Value.
**Notes:** Runbook must document prod splits api/worker, and the 90-day-expiry + spin-down caveats. Embedded-worker mode may need a small entrypoint flag (researcher to confirm/add).

---

## Kubernetes secrets & overlays

### Q1 — Secret injection

| Option                      | Description                                             | Selected |
| --------------------------- | ------------------------------------------------------- | -------- |
| Plain Secret + placeholders | Base Secret w/ placeholders; create via kubectl/overlay | ✓        |
| external-secrets refs       | ExternalSecret CRDs; hard dep on the operator           |          |
| sealed-secrets              | Encrypted SealedSecret in repo; needs controller        |          |

### Q2 — Postgres/Redis per overlay (SC#1 kind requirement)

| Option                   | Description                                                   | Selected |
| ------------------------ | ------------------------------------------------------------- | -------- |
| Dev stubs, prod external | Dev in-cluster stub pods (self-contained kind); prod external | ✓        |
| External both overlays   | Both expect operator-supplied URLs; CI supplies for kind      |          |

**User's choice:** Plain Secret + placeholders · Dev stub PG/Redis, prod external.
**Notes:** external-secrets / sealed-secrets documented as upgrade paths, not requirements.

---

## Claude's Discretion

- **Migrate image topology** — default to a dedicated distroless `Dockerfile.migrate`; api-image-with-command-override acceptable. SC#3 requires four signed images either way.
- **Heavy-test CI cadence** — default backup/upgrade/config + min-version matrix to on-release + nightly (not every PR); full CI topology is Phase 21.
- Distroless base selection, buildx cache strategy, kind/Render smoke-test harness, runbook prose structure, time-to-restore methodology.

## Deferred Ideas

- First-party Helm chart → v1.1 (kustomize-only at v1; add ROADMAP note this phase).
- traefik/caddy reverse-proxy recipes → community-contributed stubs with disclaimer.
- Full CI topology + devcontainer → Phase 21.
- Release-workflow launch polish + post-publish smoke → Phase 22.
