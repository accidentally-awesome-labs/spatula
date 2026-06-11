---
phase: 19-deployment-self-host-excellence
plan: "03"
subsystem: supply-chain
tags: [release, cosign, sbom, sigstore, multi-arch, buildx, deploy-04]
dependency_graph:
  requires: [19-02-PLAN.md]
  provides: [release-docker-job-signed, sbom-attest, verify-images-runbook]
  affects: [.github/workflows/release.yml, docs/runbooks/verify-images.md]
tech_stack:
  added: [sigstore/cosign-installer, anchore/sbom-action, docker/setup-qemu-action]
  patterns: [keyless-cosign-oidc, sign-by-digest, cyclonedx-sbom-attest, job-level-id-token, per-image-cache-scope]
key_files:
  created: [docs/runbooks/verify-images.md]
  modified: [.github/workflows/release.yml]
decisions:
  - "Sign by immutable @digest (steps.build.outputs.digest), never by tag (TOCTOU — Pitfall #3)"
  - "id-token:write at the docker JOB level (not workflow level) for keyless cosign OIDC (Pitfall #4)"
  - "SBOM (cyclonedx-json) both attested to the image AND uploaded as a GitHub release asset (D-05 both-ways)"
  - "Per-image gha cache scope (scope=matrix.image) to avoid cache-eviction races across the 4 parallel matrix builds"
metrics:
  duration_min: 35
  completed: 2026-06-11
---

# Phase 19 Plan 03: Supply-Chain Signing Summary

Extended the existing `release.yml` `docker` job to build all four images (api/worker/migrate/cli)
multi-arch (linux/amd64 + linux/arm64), keyless-cosign-sign each by immutable digest, generate +
attest a cyclonedx-json SBOM and also upload it as a release asset — plus a fresh-machine
`cosign verify` runbook. The existing release-please / npm trusted-publishing jobs are untouched.

## What was built

- **`.github/workflows/release.yml` docker job** (extends Phase 16's job):
  - Job-level `permissions: { contents: write, packages: write, id-token: write }` (id-token at JOB
    level — keyless cosign OIDC requirement, Pitfall #4).
  - 4-image matrix incl. the new `migrate` (Dockerfile.migrate from 19-02).
  - `setup-qemu-action@v3` + buildx; `platforms: linux/amd64,linux/arm64`; per-image cache
    `scope=${{ matrix.image }}`; `id: build` captures the pushed digest.
  - `cosign sign --yes …@${{ steps.build.outputs.digest }}` (sign by digest, after push).
  - `anchore/sbom-action@v0` cyclonedx-json → `cosign attest --type cyclonedx` → `softprops/action-gh-release`
    uploads `sbom-${{ matrix.image }}.cdx.json` as a release asset.
  - `release` job body updated to list all 4 image pulls + cosign/SBOM/multi-arch note + verify-images.md link.
- **`docs/runbooks/verify-images.md`** — `cosign verify` + `cosign verify-attestation` for all four
  images (keyless `--certificate-identity-regexp` + `--certificate-oidc-issuer`), arm64 verification via
  `docker pull --platform linux/arm64`, Rekor transparency-log lookup, and a namespace-substitution note.

## Validation

GitHub Actions workflow — cosign/Fulcio/Rekor only run in CI against a real published tag, so live
signing is **not** locally runnable (documented; manual smoke per VALIDATION.md). Static validation:

- `release.yml` parses as valid YAML.
- All 15 plan acceptance criteria pass (job-level id-token:write + 4-image matrix incl migrate via
  python assertion; multi-arch platforms; QEMU; per-image cache scope; `id: build`; cosign installer;
  `cosign sign --yes`; sign-by-digest; sbom-action; `cosign attest --type cyclonedx`; SBOM release-asset
  upload; verify-images.md has `cosign verify` + `cosign verify-attestation` + `certificate-oidc-issuer`).
- publish-npm job intact (db/queue/api/cli `--provenance --access public`).

## Deviations from Plan

None — plan executed as written. (Execution note: the first executor agent died on a transient API
auth error after committing the release.yml edits in f805076 and writing verify-images.md uncommitted;
the orchestrator verified the committed workflow against all acceptance criteria, committed the
already-written runbook (2d4bcb1), and finalized SUMMARY + state. No rework was needed — the artifacts
were complete and correct.)

## Known Stubs

None.

## Self-Check: PASSED

- [x] .github/workflows/release.yml — 4-image multi-arch + keyless cosign by digest + SBOM attest+asset (commit f805076)
- [x] docs/runbooks/verify-images.md — fresh-machine verify + verify-attestation (commit 2d4bcb1)
- [x] release job lists 4 images + cosign/SBOM note; publish-npm untouched
- [x] release.yml valid YAML; 15/15 acceptance criteria pass
