# Phase 19 — Deferred / Out-of-Scope Discoveries

Items found during execution that are outside the current plan's scope. Logged per the
gsd-executor scope-boundary rule (do NOT fix inline; track for the right phase/owner).

## DEFER-19-A: `@spatula/client` fails a clean isolated TypeScript build

**Found during:** Plan 19-02 (cli image build). The Docker `Dockerfile.cli` build stage
ran an unfiltered `turbo run build`, which compiled `@spatula/client` and failed with:

```
src/client.ts: error TS2304: Cannot find name 'fetch'.
src/methods/get-job-events.ts: error TS2304: Cannot find name 'MessageEvent' / 'Event' / 'URL'.
src/methods/get-entities.ts / list-jobs.ts: error TS2304: Cannot find name 'URLSearchParams'.
src/methods/get-job-events.ts: error TS2307: Cannot find module 'eventsource'.
src/version-probe.ts: error TS2304: Cannot find name 'fetch'.
```

**Notes:**

- `pnpm --filter @spatula/client build` passes LOCALLY (dev node_modules has `@types/node`
  hoisted, which supplies `fetch`/`URL`/`URLSearchParams`, and `eventsource` present). The
  failure appears only in the isolated multi-package Docker build context.
- A prior interrupted executor "fixed" this by adding `"lib": ["ES2022","DOM"]` to
  `packages/client/tsconfig.json` + an `@ts-ignore` on the `eventsource` dynamic import.
  Those edits were reverted (they were band-aids made while chasing the cli build, and the
  client is the PUBLIC SDK — its tsconfig should be changed deliberately, not as a side effect).

**Resolution in 19-02:** Sidestepped — `Dockerfile.cli` now builds with
`--filter=@spatula/cli...`, whose closure does NOT include `@spatula/client`. The cli image
never compiles the client, so the cli image build is unaffected.

**Owner / follow-up:** Phase 16 (SDK packages) / Plan 19-03 (release workflow publishes
`@spatula/client`). Verify `@spatula/client` builds in a CLEAN, isolated environment (no
hoisted dev deps) and decide the correct fix (explicit `lib`/`types` in the client tsconfig,
declare `eventsource` + its types as real deps, or split browser/node type surfaces). If the
release CI already passes, document WHY (hoisting) so it is not a latent release-time break.

**Update (2026-06-11, Plan 19-05 live deploy):** STILL OPEN. The Render build ran a full
`turbo run build` (the whole monorepo, client included) and PASSED — but only because the
build used `pnpm install --prod=false`, which hoists `@types/node` and installs `eventsource`.
That is exactly the hoisting condition this item predicted would mask the failure; it is NOT a
clean isolated build, so it neither reproduces nor resolves DEFER-19-A. The correct fix
(explicit `lib`/`types` + real `eventsource` types in the client tsconfig) is still owed.
