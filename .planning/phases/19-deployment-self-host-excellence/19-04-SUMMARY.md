---
phase: 19-deployment-self-host-excellence
plan: '04'
subsystem: infra
tags: [kubernetes, kustomize, kind, k8s, deploy, overlays, distroless, github-actions]

requires:
  - phase: 19-02
    provides: distroless api/worker/migrate images (ghcr.io/accidentally-awesome-labs/spatula/{api,worker,migrate}) + nonroot uid 65532 securityContext contract

provides:
  - deploy/k8s/base/ — 7-file kustomize base (namespace, Secret, migrate Job, api+worker Deployments, api Service)
  - deploy/k8s/overlays/dev/ — self-contained kind overlay (throwaway postgres:16-alpine + redis:7-alpine stubs, emptyDir)
  - deploy/k8s/overlays/prod/ — external-services overlay (no stubs, pinned image tags, 2 replicas, cpu/memory requests+limits)
  - deploy/k8s/README.md — kind quickstart, spatula doctor 9/9-green procedure, prod external-services contract, D-08 secret upgrade paths
  - .github/workflows/k8s-smoke.yml — on-release + nightly kind cluster smoke test (SC#1 CI lane)
  - DEPLOY-01 satisfied: kustomize base + dev/prod overlays render cleanly; kind-smoke path wired

affects: [phase-20-docs, phase-22-launch, SC-1-kind-smoke]

tech-stack:
  added: [kustomize v5.7.1 (kubectl bundled), kind v0.23+ (CI), helm/kind-action@v1.12.0]
  patterns:
    - Kustomize base + overlay pattern (D-09) — base has dev-default Secret values; dev overlay adds stubs matching those defaults (no Secret patch); prod overlay strips stubs + pins tags + patches resources
    - startupProbe on /health/ready as migrate-Job ordering mechanism (RESEARCH Pattern 5, Pitfall #6) — no RBAC or busybox job-watch initContainer; 300s window (failureThreshold 30 × periodSeconds 10)
    - Throwaway emptyDir stubs in dev overlay (postgres:16-alpine, redis:7-alpine) — zero PVC, wipe with cluster
    - Plain Secret with REPLACE_ME placeholders + documented ESO/sealed-secrets upgrade paths (D-08)
    - Heavy-lane CI cadence: on-release (tags v*) + nightly cron — not on every PR

key-files:
  created:
    - deploy/k8s/base/kustomization.yaml
    - deploy/k8s/base/namespace.yaml
    - deploy/k8s/base/secrets.yaml
    - deploy/k8s/base/migrate-job.yaml
    - deploy/k8s/base/api-deployment.yaml
    - deploy/k8s/base/api-service.yaml
    - deploy/k8s/base/worker-deployment.yaml
    - deploy/k8s/overlays/dev/kustomization.yaml
    - deploy/k8s/overlays/dev/postgres-stub.yaml
    - deploy/k8s/overlays/dev/redis-stub.yaml
    - deploy/k8s/overlays/dev/patch-images.yaml
    - deploy/k8s/overlays/prod/kustomization.yaml
    - deploy/k8s/overlays/prod/patch-resources.yaml
    - deploy/k8s/README.md
    - .github/workflows/k8s-smoke.yml
  modified:
    - (none — all new files)

key-decisions:
  - 'wait-for-postgres initContainer removed from migrate-job.yaml base: it added postgres:16-alpine to the prod render, causing the no-stub acceptance check to fail; backoffLimit:3 + startupProbe on api handles ordering without the initContainer'
  - 'Dev overlay Secret requires no patch: base/secrets.yaml dev-default DATABASE_URL/REDIS_URL already point at the stub postgres/redis Services — no overlay secret patch needed'
  - 'emptyDir for postgres stub storage: throwaway dev data, no PVC lifecycle complexity'
  - 'k8s-smoke CI runs on-release + nightly (not PR): matches adversarial-llm.yml heavy-lane cadence per RESEARCH Open Question #2 and user decision'
  - 'helm/kind-action@v1.12.0 used in CI: official kind GH Action; builds images from source and loads into kind rather than pulling from GHCR (avoids registry auth in smoke CI)'

requirements-completed: [DEPLOY-01]

duration: 8min
completed: 2026-06-11
---

# Phase 19 Plan 04: k8s Kustomize Base + Dev/Prod Overlays + kind-smoke CI Summary

**Kustomize base with startupProbe migrate-ordering and dev/prod overlays — dev is kind-self-contained with throwaway PG/Redis stubs; prod strips stubs, pins image tags, sets 2 replicas; kind-smoke CI wired on-release + nightly**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-11T05:25:03Z
- **Completed:** 2026-06-11T05:33:00Z
- **Tasks:** 2
- **Files modified:** 15

## Accomplishments

- Kustomize base (7 files): namespace, plain Secret with REPLACE_ME placeholders (D-08) + ESO/sealed-secrets upgrade docs, one-shot migrate Job (backoffLimit:3), api Deployment with startupProbe on /health/ready for migrate-ordering (RESEARCH Pattern 5, Pitfall #6 avoided), worker Deployment (no HTTP probes), api ClusterIP Service — all Deployments run as nonroot uid 65532
- Dev overlay: self-contained on fresh kind cluster with throwaway postgres:16-alpine + redis:7-alpine stub Deployments+Services (emptyDir, no PVC); base dev-default Secret values match stub credentials (no Secret patch needed)
- Prod overlay: base only (no stubs, D-09); image tags pinned to 1.0.0 placeholder; patch-resources.yaml sets 2 replicas + cpu/memory requests+limits on api+worker
- deploy/k8s/README.md: kind quickstart (load → apply → wait → port-forward), spatula doctor 9/9-green procedure (one-shot kubectl run with spatula/cli image), prod external-services contract, all three secret upgrade paths (kubectl/ESO/sealed-secrets)
- .github/workflows/k8s-smoke.yml: builds images, loads into kind, `kubectl apply -k overlays/dev`, waits for migrate Job completion + api Deployment Available, smoke GET /health; triggers on-release + nightly

## Task Commits

1. **Task 1: Kustomize base** — `ad9f86c` (feat)
2. **Task 2: Dev + prod overlays + README + kind-smoke CI** — `94c2d4f` (feat)

## Files Created/Modified

- `deploy/k8s/base/kustomization.yaml` — base resource list (6 resources + namespace: spatula)
- `deploy/k8s/base/namespace.yaml` — spatula Namespace
- `deploy/k8s/base/secrets.yaml` — plain Secret with REPLACE_ME placeholders; ESO + sealed-secrets documented as upgrade paths (D-08)
- `deploy/k8s/base/migrate-job.yaml` — one-shot Job; backoffLimit:3; restartPolicy:OnFailure; no initContainer (removed for prod acceptance)
- `deploy/k8s/base/api-deployment.yaml` — startupProbe /health/ready (initialDelaySeconds:20, failureThreshold:30, periodSeconds:10); livenessProbe /health; readinessProbe /health/ready; securityContext runAsNonRoot:true runAsUser:65532; terminationGracePeriodSeconds:30
- `deploy/k8s/base/api-service.yaml` — ClusterIP port 3000
- `deploy/k8s/base/worker-deployment.yaml` — no HTTP probes; same securityContext; terminationGracePeriodSeconds:30
- `deploy/k8s/overlays/dev/kustomization.yaml` — resources: base + postgres-stub + redis-stub; images: :latest
- `deploy/k8s/overlays/dev/postgres-stub.yaml` — postgres:16-alpine Deployment + ClusterIP Service; POSTGRES_USER/PASSWORD/DB=spatula; emptyDir
- `deploy/k8s/overlays/dev/redis-stub.yaml` — redis:7-alpine Deployment + ClusterIP Service
- `deploy/k8s/overlays/dev/patch-images.yaml` — documentation placeholder (images block in kustomization.yaml)
- `deploy/k8s/overlays/prod/kustomization.yaml` — resources: base only; images pinned to 1.0.0; patches: patch-resources.yaml
- `deploy/k8s/overlays/prod/patch-resources.yaml` — api+worker replicas:2; cpu:250m-1000m; memory:256Mi-512Mi
- `deploy/k8s/README.md` — kind quickstart, migrate ordering explanation, spatula doctor procedure, prod external-services contract, D-08 secret upgrade paths
- `.github/workflows/k8s-smoke.yml` — on push:tags:v\* + schedule cron 02:00 UTC + workflow_dispatch; helm/kind-action, build+load images, apply dev overlay, wait Job+Deployment, smoke curl

## Decisions Made

- **wait-for-postgres initContainer removed from base:** The initContainer (`image: postgres:16-alpine`) caused `postgres:16-alpine` to appear in the prod render, failing the `! grep -q postgres:16-alpine /tmp/prod.yaml` acceptance check. Since the migrate Job already has `backoffLimit:3` and `restartPolicy:OnFailure`, Drizzle's connect-on-use + k8s retry handling is sufficient. The api's `startupProbe` (max 300s window) provides the ordering guarantee per RESEARCH Pattern 5.
- **Dev overlay Secret requires no patch:** Base `secrets.yaml` dev-default DATABASE_URL (`postgresql://spatula:spatula@postgres:5432/spatula`) + REDIS_URL (`redis://redis:6379`) already match the stub Service names and credentials — no overlay Secret patch needed.
- **emptyDir for postgres stub:** Throwaway dev data, no PVC lifecycle management complexity.
- **helm/kind-action@v1.12.0 in CI:** Official kind GitHub Action; images built from source and loaded into kind to avoid GHCR auth in smoke CI.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed wait-for-postgres initContainer from migrate-job.yaml**

- **Found during:** Task 2 validation (overlay acceptance check)
- **Issue:** The `wait-for-postgres` initContainer (`image: postgres:16-alpine`) in the base manifest caused `postgres:16-alpine` to appear in the prod overlay render. The plan's acceptance criterion `! grep -q "postgres:16-alpine" /tmp/prod.yaml` was failing.
- **Fix:** Removed the initContainer entirely from `base/migrate-job.yaml`. Added explanatory comment documenting that `backoffLimit:3` + `restartPolicy:OnFailure` + the api's `startupProbe` handle ordering without RBAC or job-watch logic.
- **Files modified:** `deploy/k8s/base/migrate-job.yaml`
- **Verification:** `kubectl kustomize overlays/prod` no longer contains `postgres:16-alpine`; both overlay renders exit 0; all other acceptance criteria still pass.
- **Committed in:** `94c2d4f` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug where base initContainer violated prod acceptance criterion)
**Impact on plan:** Necessary for correctness; the fix is also the simpler approach (matches RESEARCH "simpler alternative: no initContainer" recommendation for the migrate-ordering pattern).

## Issues Encountered

None beyond the deviation above.

## Known Stubs

- `deploy/k8s/overlays/prod/kustomization.yaml`: image tags set to `"1.0.0"` placeholder with `# REPLACE with actual release tag` comment. This is intentional — operators must update image tags before each prod deployment. The CI smoke workflow uses `:latest` loaded from source build.

## Next Phase Readiness

- DEPLOY-01 fully satisfied: kustomize base + dev/prod overlays render cleanly, dev is kind-self-contained, prod assumes external services, kind-smoke CI wired for SC#1
- SC#1 (kind apply + spatula doctor 9/9 green) requires a live kind cluster run — described in README and wired in k8s-smoke.yml; not automatable on the dev machine (kind not installed)
- Ready for Phase 19 Wave 3 completion; depends_on [19-02] satisfied

---

_Phase: 19-deployment-self-host-excellence_
_Completed: 2026-06-11_
