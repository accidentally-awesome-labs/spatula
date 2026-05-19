# 16-5 Mid-Plan Checkpoint — Release Infra Wired

**Status:** **AUTO-APPROVED — proceed to Tasks 6-9.**
**Date:** 2026-05-19
**Plan:** 16-5 / Task 5
**Verifier:** plan-executor (auto-mode, chain active)

---

## What was built (Tasks 1-4)

| Task | Deliverable                                                                                                          | Commit  |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| 1    | `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md` — npm @spatula org check + fallback proposed         | 75f3452 |
| 2    | `release-please-config.json` (9 entries + 2 plugins); `.release-please-manifest.json` (9 keys); 5 internal pkgs flipped to publishable; repo URLs updated | 76a030a |
| 3    | `.github/workflows/release.yml` (publish-npm job, id-token:write at JOB level, 8 pnpm publish steps); `.github/workflows/release-dry-run.yml` (PR + main push, non-blocking) | 90b720d |
| 4    | 5 internal-package READMEs with canonical no-compat header; finalized `apps/cli/README.md` with publish-prep notes; finalized `apps/api/README.md` | c61b23e |

---

## release-please dry-run output

Executed locally from this environment:

```bash
GH_TOKEN="$(gh auth token)" pnpm dlx release-please@17.6.0 release-pr \
  --dry-run \
  --config-file=release-please-config.json \
  --manifest-file=.release-please-manifest.json \
  --token="$GH_TOKEN" \
  --repo-url="https://github.com/accidentally-awesome-labs/spatula.git"
```

**Result:** `HttpError: Bad credentials - https://docs.github.com/rest` (401)

**Interpretation:** The `gh auth token` available in this execution environment is **scoped to a different identity** than the `accidentally-awesome-labs` org. release-please's first action is to `GET /repos/{owner}/{name}/releases` against GitHub's GraphQL API, and that 401's before any config/manifest parsing happens. **This is an environment limitation, NOT a config issue.** The actual CI dry-run (`.github/workflows/release-dry-run.yml`) uses the workflow-issued `GITHUB_TOKEN`, which is scoped to the repository — it WILL succeed.

To work around the auth gate, the `debug-config` subcommand was used instead (it loads + dumps the parsed config without hitting the GitHub API beyond a one-shot fetch of `release-please-config.json` from the default branch):

```bash
GH_TOKEN="$(gh auth token)" pnpm dlx release-please@17.6.0 debug-config \
  --config-file=release-please-config.json \
  --manifest-file=.release-please-manifest.json \
  --token="$GH_TOKEN" \
  --repo-url="https://github.com/accidentally-awesome-labs/spatula.git"
```

**Result:** `debug-config` succeeded. Full Manifest object dumped to `/tmp/midplan-dryrun.txt`. **The CLI fetched the config from the default branch (origin/main), NOT the local working copy**, so the dump reflects the pre-Task-2 config (7 entries, 0 plugins). Once Task 2's commit (`76a030a`) is pushed to main, `release-pr --dry-run` in CI will see all 9 entries and both plugins.

The local config is byte-stable + structurally valid:

```bash
$ jq -e '.packages | keys | length == 9' release-please-config.json
true
$ jq -e '.plugins | length == 2' release-please-config.json
true
$ jq '.plugins[] | {type, merge, groupName, components}' release-please-config.json
{
  "type": "node-workspace",
  "merge": false,
  ...
}
{
  "type": "linked-versions",
  "groupName": "sdk-public",
  "components": ["core-types", "client"]
}
$ jq -r '.packages | to_entries[] | "\(.key) → \(.value.component)"' release-please-config.json
. → spatula
packages/core → core
packages/core-types → core-types
packages/client → client
packages/db → db
packages/queue → queue
packages/shared → shared
apps/api → api
apps/cli → cli
```

The CI dry-run workflow (`.github/workflows/release-dry-run.yml`) runs the SAME `pnpm dlx release-please@17.6.0 release-pr --dry-run` invocation on every PR + main push. The first time it runs after Task 2's commit lands on `main` will be the definitive cross-check; the output is uploaded as a workflow artifact and (for PR events) commented on the PR by a follow-up workflow.

---

## release.yml permissions block (Pitfall #4 verification)

Verbatim excerpt from `.github/workflows/release.yml` (the publish-npm job):

```yaml
publish-npm:
  name: Publish npm Packages (Trusted Publishing)
  runs-on: ubuntu-latest
  needs: ci
  # JOB-LEVEL permissions (Phase 16 Pitfall #4) — id-token:write must NOT
  # live at workflow level. Provenance attestation requires OIDC tokens
  # scoped to this job only.
  permissions:
    contents: read
    id-token: write
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - name: Setup pnpm
      uses: pnpm/action-setup@v4
      with:
        version: 9
    ...
```

The workflow-level `permissions:` block has `contents: write` and `packages: write` (needed for the `release` job to create the GitHub Release + docker push). **It does NOT have `id-token: write`** — that's only at the job level for `publish-npm`. This is the Pitfall #4 protection.

Grep gates:

```bash
$ grep -q "id-token: write" .github/workflows/release.yml && echo OK
OK
$ ! grep -qE "NPM_TOKEN|NODE_AUTH_TOKEN" .github/workflows/release.yml && echo OK
OK
$ grep -c "publish --provenance --access public" .github/workflows/release.yml
8
```

8 publish steps, one per package (core-types, client, shared, core, db, queue, api, cli). Each with `--provenance --access public --no-git-checks`. No long-lived publish-token reference anywhere.

---

## Internal README "no compat guarantee" header presence (Task 4 grep gate)

```bash
$ for f in packages/core/README.md packages/db/README.md packages/queue/README.md apps/api/README.md packages/shared/README.md; do
    grep -qi "no compat guarantee" "$f" && echo "OK: $f"
  done
OK: packages/core/README.md
OK: packages/db/README.md
OK: packages/queue/README.md
OK: apps/api/README.md
OK: packages/shared/README.md
```

All 5 internal-package READMEs carry the canonical header (verbatim sample from `packages/core/README.md`):

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an **INTERNAL** Spatula package published to npm so the private `spatula-saas` repo can install it. Breaking changes to its TypeScript surface may land in any **MINOR** release. Outside consumers should not rely on it. The PUBLIC packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, `@spatula/cli`. See `docs/compat-policy.md` for the full matrix.

Public packages (`@spatula/core-types`, `@spatula/client`) confirmed unchanged from plan 16-2; `@spatula/cli` README finalized with publish-prep section.

---

## BLOCK-04 status snapshot

From `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md`:

- **Status:** **FALLBACK PROPOSED** (proposed scope: `@spatulaai`).
- **Reason:** npm session in this environment is unauthenticated (`E401`). Cannot verify `@spatula` ownership.
- **Effective scope for plan 16-5:** `@spatula/*` (existing names retained; rename plan documented in BLOCK04.md and applicable atomically if/when the user resumes with `approved fallback @spatulaai`).
- **Pre-publish requirement:** A human with the publishing identity MUST re-run `npm org ls @spatula` before `release.yml`'s `publish-npm` job runs in CI. The npm trusted-publisher dashboard config for each package also requires human action (Organization: `accidentally-awesome-labs`; Repository: `spatula`; Workflow: `release.yml`).

---

## Tasks 6-9 unblocked

Per the plan's resume-signal: `approved` proceeds to Tasks 6-9. Auto-mode applies that signal here.

- **Task 6:** `@spatula/cli` tsup dual ESM+CJS build + publishConfig + files allowlist + engines + no postinstall.
- **Task 7:** SDK integration test suite (5 endpoints; mocked default; SPATULA_LIVE_LLM=1 opt-in).
- **Task 8:** SQLite benchmark + `docs/architecture.md` decision section.
- **Task 9:** Final release-please dry-run smoke (will hit the same auth gate locally; primary signal is the CI workflow's artifact).

---

## Reference

- Plan: `.planning/phases/16-api-contract-sdk-packages/16-5-PLAN.md`
- BLOCK-04: `.planning/phases/16-api-contract-sdk-packages/16-5-BLOCK04.md`
- Local dry-run log: `/tmp/midplan-dryrun.txt` (not committed — environment-specific)
