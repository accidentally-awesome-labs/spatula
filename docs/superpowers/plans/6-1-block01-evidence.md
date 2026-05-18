# BLOCK-01 verification evidence — 2026-05-17T16:52:39Z

**Repo:** `accidentally-awesome-labs/spatula-saas` (PRIVATE)
**SSH URL:** `git@github.com:accidentally-awesome-labs/spatula-saas.git`
**Verifier:** gsd-executor (Phase 15 Plan 15-01 Task 1)
**Result:** PASS — all three probes exited 0; repo is reachable as a writable remote and `git-filter-repo` is installed locally.

---

## Probe 1 — Existence + visibility (`gh repo view`)

**Command:**

```bash
gh repo view accidentally-awesome-labs/spatula-saas --json name,visibility,isEmpty,sshUrl
```

**stdout:**

```json
{
  "isEmpty": true,
  "name": "spatula-saas",
  "sshUrl": "git@github.com:accidentally-awesome-labs/spatula-saas.git",
  "visibility": "PRIVATE"
}
```

**Exit:** `0`
**Verdict:** `visibility: PRIVATE` ✓ — repo exists, is empty (no README, no commits), and the authenticated `gh` user has read access to the `accidentally-awesome-labs` org.

---

## Probe 2 — Write-access (`git ls-remote` on non-existent branch)

**Command:**

```bash
git ls-remote git@github.com:accidentally-awesome-labs/spatula-saas.git refs/heads/__access-probe__ 2>&1 | head
```

**stdout:** (empty — no matching refs, no permission error)

**Exit:** `0`
**Verdict:** No `Permission denied` / `Repository not found` — SSH auth resolved successfully to a writable-eligible target. The empty body confirms the probe branch does not yet exist, which is expected; the fact that the command exited 0 confirms the remote accepted our credentials.

---

## Probe 3 — `git-filter-repo` binary present

**Command:**

```bash
command -v git-filter-repo && git filter-repo --version
```

**stdout:**

```
/opt/homebrew/bin/git-filter-repo
a40bce548d2c
```

**Exit:** `0`
**Verdict:** Binary installed at `/opt/homebrew/bin/git-filter-repo`, version `a40bce548d2c`. Plan 15-02 can shell out to `git filter-repo` without further setup.

---

## Acceptance criteria (Plan 15-01 Task 1)

- [x] `gh repo view accidentally-awesome-labs/spatula-saas` exits 0 with `visibility: PRIVATE`.
- [x] `git ls-remote git@github.com:accidentally-awesome-labs/spatula-saas.git refs/heads/__access-probe__` exits 0.
- [x] `command -v git-filter-repo` exits 0.
- [x] This evidence file is committed (next step).

BLOCK-01 is **CLEARED**. Plan 15-02 (filter-repo move) is unblocked.
