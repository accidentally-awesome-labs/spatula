---
status: resolved
trigger: "Fix the Phase 17 browser e2e suite tests/e2e/browser/oidc-sse-flow.spec.ts so all 4 tests pass"
created: 2026-05-20T02:10:00Z
updated: 2026-05-20T02:20:00Z
---

## Current Focus

hypothesis: CONFIRMED — callback server on 127.0.0.1:3000 is shadowed by an external Next.js dev server (Genomarker) that listens on *:3000 (IPv6). When Playwright navigates to localhost:3000/callback, macOS resolves localhost to ::1 (IPv6), which hits the Genomarker server instead of our IPv4 callback server.
test: Confirmed by direct fetch test: fetch('http://localhost:3000/callback?code=test123') returns full Genomarker Next.js HTML (404 page)
expecting: Fix by changing DEX_REDIRECT_URI to use 127.0.0.1:SOMEPORT (not localhost:3000), updating dex.yaml redirectURIs to match, and ensuring callback server listens on same 127.0.0.1:PORT
next_action: Change port to 4000 and use 127.0.0.1 explicitly in redirect URI, dex.yaml, and callback server bind

## Symptoms

expected: Step 1 OIDC flow completes and accessToken is set
actual: OAuth callback timed out after 30000ms — callback never received
errors: "OAuth callback timed out after 30000ms"
reproduction: pnpm exec vitest run --config tests/e2e/browser/vitest.config.ts
started: First time running this suite

## Eliminated

- hypothesis: Dex is not running or misconfigured
  evidence: curl http://localhost:5556/dex/.well-known/openid-configuration returns 200; smoke/browser-flow.ts runs to completion
  timestamp: 2026-05-20T02:12:00Z

- hypothesis: Playwright selectors don't match Dex login form
  evidence: smoke/browser-flow.ts uses identical selectors (input[name=login], button[type=submit]) and works
  timestamp: 2026-05-20T02:12:00Z

- hypothesis: Port 3000 is not reachable
  evidence: Node can bind to 127.0.0.1:3000 without error; IPv4 port is accessible
  timestamp: 2026-05-20T02:13:00Z

## Evidence

- timestamp: 2026-05-20T02:11:00Z
  checked: smoke/browser-flow.ts execution
  found: browser-flow-ok — full OIDC flow works end-to-end with identical code
  implication: Dex, Playwright, credentials, PKCE all work correctly

- timestamp: 2026-05-20T02:13:00Z
  checked: lsof -i TCP:3000
  found: PID 3656 next-server (Genomarker project) listening on *:3000 (IPv6, all interfaces)
  implication: Port 3000 IPv6 is occupied by another process

- timestamp: 2026-05-20T02:14:00Z
  checked: fetch('http://localhost:3000/callback?code=test123') while test's server on 127.0.0.1:3000
  found: Returns Genomarker HTML (404 page), NOT our callback server response
  implication: localhost resolves to ::1 on macOS, which hits the existing IPv6 server. Our callback server on 127.0.0.1 never receives the redirect.

- timestamp: 2026-05-20T02:14:30Z
  checked: fetch('http://127.0.0.1:3001/callback?code=test') with server on 127.0.0.1:3001
  found: Returns 'ok' — correct response
  implication: Using 127.0.0.1 explicitly (not localhost) routes directly to IPv4 and avoids the conflict

## Resolution

root_cause: Four compounding bugs:
  1. DEX_REDIRECT_URI used 'localhost:3000'. macOS resolves 'localhost' to ::1 (IPv6). A Genomarker Next.js dev server occupied *:3000 (IPv6). Playwright's redirect hit that server instead of the test's IPv4 callback server → captureOAuthCallback() timed out.
  2. JwtAuthProvider configured with no m2mClientScopes or defaultBrowserUserScopes — browser OIDC tokens got scopes:[] — requireScope('jobs:write') returned 403.
  3. startApiServer() missing userTenantRepo, jobManager, and other repos — JWT tenant auto-provisioning and job creation were impossible.
  4. Test's publisher.publish() calls used invalid JobEventType values ('job.status', 'job.progress') and omitted tenantId — SSE handler's tenant filter dropped all events. Also, subscribeJobEvents SDK did not inject SSE id: frame value into the delivered JobEvent, so capturedLastId was always undefined.
fix:
  1. Changed DEX_REDIRECT_URI to 'http://127.0.0.1:4000/callback'; updated dex.yaml to add this as a valid redirect URI; callback server now listens on 127.0.0.1:4000.
  2. Added defaultBrowserUserScopes option to JwtAuthProvider; test server passes DEFAULT_API_KEY_SCOPES.
  3. Wired UserTenantRepository, JobManager, and all required repos in startApiServer().
  4. Fixed publisher.publish() calls to use valid JobEventType values and include tenantId; fixed subscribeJobEvents SDK to inject e.lastEventId into delivered JobEvent.id.
  5. Fixed job creation request body to match actual createJobSchema (crawl + schema + llm fields required).
verification: pnpm exec vitest run --config tests/e2e/browser/vitest.config.ts — 4/4 pass, stable across 2 runs.
files_changed:
  - tests/e2e/browser/oidc-sse-flow.spec.ts
  - examples/auth-dex/config/dex.yaml
  - apps/api/src/auth/jwt-provider.ts
  - packages/client/src/methods/get-job-events.ts
