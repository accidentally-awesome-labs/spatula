# Changelog

## [0.1.0](https://github.com/accidentally-awesome-labs/spatula/compare/api-v0.0.1...api-v0.1.0) (2026-06-11)


### Features

* **16-1:** add X-RateLimit-Reset header + config/rate-limits.yaml loader ([c46795e](https://github.com/accidentally-awesome-labs/spatula/commit/c46795ea23fb57b0b3c3037a2d332813cc71cd38))
* **16-1:** split pagination envelope (cursor canonical, offset deprecated) + RFC 8594 headers ([7b75687](https://github.com/accidentally-awesome-labs/spatula/commit/7b75687e13034bb383001eace346d8bab473fca5))
* **16-1:** sweep API error envelope to frozen DOMAIN.CODE enum + details ([e3c3ae9](https://github.com/accidentally-awesome-labs/spatula/commit/e3c3ae901773d411a1ea4d03b901ff98e9cac82f))
* **16-2:** add ESLint rule blocking non-type imports from @spatula/core-types ([5da3ddd](https://github.com/accidentally-awesome-labs/spatula/commit/5da3ddd90f1257e1bece5d1a5871f082c3b901fa))
* **16-3:** add GET /.well-known/spatula-version + support matrix ([1912241](https://github.com/accidentally-awesome-labs/spatula/commit/191224165f71d44801b428e3517c9576d9710f89))
* **16-3:** boot-cache OpenAPI 3.1 spec + dev-mode example validator ([79271f3](https://github.com/accidentally-awesome-labs/spatula/commit/79271f343113a7ce6d039505f504848c2d118cdc))
* **16-4:** ship contract test suite (matrix driver + 6 per-REQ suites) + CI gate ([1d5ba4a](https://github.com/accidentally-awesome-labs/spatula/commit/1d5ba4a2515b9d9c9b4c9859e4688897275390e3))
* **16-5:** extend release-please to 8 packages + linked-versions + node-workspace plugins ([76a030a](https://github.com/accidentally-awesome-labs/spatula/commit/76a030af9b4558594f39d6513e07c79053c0ee54))
* **17-02:** build SSE module — types, RedisStreamBuffer, and route handler ([f54d62a](https://github.com/accidentally-awesome-labs/spatula/commit/f54d62af55ace8c1d19307175fc1642a9d1f2c91))
* **17-02:** register SSE createRoute, mount in app, fix auth+timeout+scope guards ([5dfb16c](https://github.com/accidentally-awesome-labs/spatula/commit/5dfb16ce2ac319d712314173f04285bcc2c11fcb))
* **17-03:** CORS function-form origin matcher with single-label wildcard ([404c364](https://github.com/accidentally-awesome-labs/spatula/commit/404c364ffcbcb45694c0bb9d80748accfe3d5831))
* **17-03:** docs/api-auth.md authoritative auth doc + scope sync CI gate ([5b6791c](https://github.com/accidentally-awesome-labs/spatula/commit/5b6791c358ab4099cd6be35301c903bf6bacebfd))
* **17-04:** add POST /api/v1/api-keys/:id/rotate route with grace window + audit ([70e5d2c](https://github.com/accidentally-awesome-labs/spatula/commit/70e5d2c96f6b3f816084685243ccaa1178579eba))
* **17-07:** M2M OIDC client_credentials e2e suite (AUTH-08) ([81416b5](https://github.com/accidentally-awesome-labs/spatula/commit/81416b5919c73792555af73147de10988a955ef4))
* **18-05:** admin:forensic:read scope + forensic endpoint + OpenAPI experimental (SEC-05) ([adb17dc](https://github.com/accidentally-awesome-labs/spatula/commit/adb17dc433e6bea264f2b7a450d69c847721aaa1))
* **18-06:** DELETE + import admin routes (async 202) ([4ad8a9f](https://github.com/accidentally-awesome-labs/spatula/commit/4ad8a9fa3fac877ff463a481660b358102291bc5))
* **19-01:** API standalone bootstrap (main.ts) + embedded-worker shim ([4d365fd](https://github.com/accidentally-awesome-labs/spatula/commit/4d365fd8fdf83024f97a0a5cff611af2d93bbbb5))
* **19-02:** distroless api + worker runtime images (DEPLOY-03) ([92dd2dd](https://github.com/accidentally-awesome-labs/spatula/commit/92dd2ddd985d772e25abb8df49aacbb8a0a4347b))
* add webhook config schema and enqueue helper ([d5764f1](https://github.com/accidentally-awesome-labs/spatula/commit/d5764f1bd54aaa5ad7fb5fa60bab29e45d54d4a5))
* **admin:** add cross-tenant job listing and force-cancel endpoints ([b0b40e2](https://github.com/accidentally-awesome-labs/spatula/commit/b0b40e2e2ff0d4ded65dc98ef8e7d340a4679950))
* **admin:** add system health and metrics endpoints ([2af30bb](https://github.com/accidentally-awesome-labs/spatula/commit/2af30bb19326dabf35db6fcb63217764b3439f2b))
* **admin:** add tenant management routes (list, detail, update plan/config/retention) ([b07028d](https://github.com/accidentally-awesome-labs/spatula/commit/b07028d5d683770e1459d7566c1b3cdb3e4dbccc))
* **admin:** enable cross-tenant DLQ access for admin-scoped callers ([aae3f05](https://github.com/accidentally-awesome-labs/spatula/commit/aae3f05cbdb9e1e9e819b3565d75f7109449920c))
* **api:** add batch operations, timeout middleware, and wire into app ([90a70ce](https://github.com/accidentally-awesome-labs/spatula/commit/90a70ce6f3e8169769eea407a6bfdcad9547e6d9))
* **api:** add billing routes (subscription, invoices, portal) and wire AppDeps ([053dbc4](https://github.com/accidentally-awesome-labs/spatula/commit/053dbc44854fe8f54e985fc4c277675eeb893227))
* **api:** add pageUrl to extractions, entity-sources endpoint, job stats enrichment ([da98cba](https://github.com/accidentally-awesome-labs/spatula/commit/da98cbad19e4d00642fa997a417b9d205995cb89))
* **api:** add SpatulaStripeClient wrapper using Billing Meter Events API ([4f053ee](https://github.com/accidentally-awesome-labs/spatula/commit/4f053eeb3f7487a9bf15e7307ab9e898e9f6084f))
* **api:** add Stripe webhook handler with signature verification, register billing routes ([a0846a1](https://github.com/accidentally-awesome-labs/spatula/commit/a0846a13556338efe2283f38fce5acb81e3c5c38))
* **api:** align rate limiting with billing plan, wire billing routes ([1ab1621](https://github.com/accidentally-awesome-labs/spatula/commit/1ab162167bc962359b1c39b0a896860c2d98d352))
* **api:** raise entity pagination limit from 100 to 500 for bulk pull support ([cac57c2](https://github.com/accidentally-awesome-labs/spatula/commit/cac57c29f5c4ac1fd50bdb843a5a33cb38eed69a))
* **api:** restrict export formats based on billing tier ([bddc9ae](https://github.com/accidentally-awesome-labs/spatula/commit/bddc9aef1aed600eae7515c738253eab280ac9ef))
* **api:** wire queue_depth gauge to BullMQ getJobCounts ([0d80b47](https://github.com/accidentally-awesome-labs/spatula/commit/0d80b47ee84727f6d84863080c662e13c80c6b9c))
* **auth:** add strategy field to AuthResult, stop requiring tenant_id in JWT ([736cf59](https://github.com/accidentally-awesome-labs/spatula/commit/736cf5952c10f03d5d5c75dd0684104ede9afb2b))
* **auth:** enforce 403 for suspended tenants in validate-tenant middleware ([65801a2](https://github.com/accidentally-awesome-labs/spatula/commit/65801a2e70c974a78b4e6d5afdc05d6c4d306d94))
* **auth:** JWT user→tenant resolution via user_tenants table ([87dff97](https://github.com/accidentally-awesome-labs/spatula/commit/87dff979fea4766d24e3ddc10afff2e55c2e21c6))
* **carveout:** add GET /api/v1/auth/me — auth introspection for API-key verification ([c10625a](https://github.com/accidentally-awesome-labs/spatula/commit/c10625a60d0478a6fcbd6a8a84849a2de88d0f75))
* **carveout:** clean up residual billing coupling in admin-tenants + exports tests ([5d3b50e](https://github.com/accidentally-awesome-labs/spatula/commit/5d3b50efee981f52c64f70bb5b17e0fc382bdb84))
* **carveout:** confirm SQLite schema has no billing coupling ([7d2e818](https://github.com/accidentally-awesome-labs/spatula/commit/7d2e8186239b2facc21aa4563bf4d8c83e157530))
* **carveout:** delete Section A billing files from OSS (history preserved in spatula-saas) ([20318a6](https://github.com/accidentally-awesome-labs/spatula/commit/20318a66f7da62cd5e484cdeb32a2dd20b953243))
* **carveout:** drop tier-based rate-limit lookup; use DEFAULT_RATE_LIMIT ([76e7577](https://github.com/accidentally-awesome-labs/spatula/commit/76e7577522ab56ac0b22b2facb80215b6d27855e))
* **carveout:** remove QuotaEnforcer coupling from queue + core + api layers ([c449fcd](https://github.com/accidentally-awesome-labs/spatula/commit/c449fcdb2ebb8265bd3462f7e2a83e114c236fda))
* **carveout:** strip BILLING_TIERS + plan + usage aggregation from admin-tenants ([0d72430](https://github.com/accidentally-awesome-labs/spatula/commit/0d724300fb8cd63c03541ab255c5e7a821885544))
* **carveout:** unmount billing + stripe-webhook routes + plan-loading middleware from app.ts ([6ac966c](https://github.com/accidentally-awesome-labs/spatula/commit/6ac966c7a58fcdffd3b2b0c94bd6dd402040b90c))
* **cli:** add Tier 4 test helpers for API lifecycle testing ([4ccb70f](https://github.com/accidentally-awesome-labs/spatula/commit/4ccb70f8cc7cba9acea8695a2dd306a03a74113b))
* flip default LLM model to deepseek/deepseek-v4-pro + add pricing ([342729e](https://github.com/accidentally-awesome-labs/spatula/commit/342729eff64d59c62236e6e81750336111b45495))
* **queue:** add hourly metering worker for Stripe usage reporting ([a4d8d97](https://github.com/accidentally-awesome-labs/spatula/commit/a4d8d9796dabe5ed3478a155f7c966c9082b4815))
* **queue:** add webhook queue, worker, and Bull Board registration ([8e1cc24](https://github.com/accidentally-awesome-labs/spatula/commit/8e1cc24e2ccc43726293e554c8c6916ce2990806))
* Wave 5-6 — deferred items (10 items, 16 commits) ([413ac19](https://github.com/accidentally-awesome-labs/spatula/commit/413ac1992a1b33feea8081e60ccdd08c2cf13146))


### Bug Fixes

* **15-03:** clean up post-carveout lint residue ([9785066](https://github.com/accidentally-awesome-labs/spatula/commit/9785066b6078cfd6f005824cb24fca3aa23e7f08))
* **15-ci:** get PR CI green — format pass, lint cleanup, workflow fixes ([918f364](https://github.com/accidentally-awesome-labs/spatula/commit/918f3649e216204971fe9c12b00e8a39d70c980a))
* **15-followup:** retire post-merge pg_dump gate + bump CI-flaky test timeouts ([95f0127](https://github.com/accidentally-awesome-labs/spatula/commit/95f0127a6715cbb8ee8fb5d0550cff04fab4dfe9))
* **16-3:** widen openapi route handler to satisfy strict response type ([3f3e16c](https://github.com/accidentally-awesome-labs/spatula/commit/3f3e16c79736fd6abe4930a38e79f87b3d07e0f4))
* **17-06:** repair browser e2e OIDC flow — localhost IPv6 collision, scope grant, repo wiring, event publishing, SSE id injection ([69280ec](https://github.com/accidentally-awesome-labs/spatula/commit/69280ec7b4b526b94a341d5d3f07152b21a4f63f))
* **17-07:** restore fail-closed JWT scopes, grant M2M scopes explicitly ([fa9565d](https://github.com/accidentally-awesome-labs/spatula/commit/fa9565d76fe104217381bb71e970c29a3402e0b9))
* add error boundaries to extraction/action pull loops + defer storageBytesUsed ([733f298](https://github.com/accidentally-awesome-labs/spatula/commit/733f2986d4cd13947e58e488180dfe9a0cf1fe57))
* address code review findings — validate plan from Stripe, add stripe_customer_id index, fix idempotency key, safe metering deps construction ([bf6ee6c](https://github.com/accidentally-awesome-labs/spatula/commit/bf6ee6c107d979f92b8975f51cda1dcf28327ca6))
* address spec compliance review findings ([1c0e869](https://github.com/accidentally-awesome-labs/spatula/commit/1c0e8699069fa788409254065a4e483d2f55830e))
* address Wave 4-1 code quality review findings ([f97c5f7](https://github.com/accidentally-awesome-labs/spatula/commit/f97c5f7813ff20e73eefc9e98b0b63c5db5f3639))
* **api:** add shared-secret protection for tenant creation endpoint ([4f0d033](https://github.com/accidentally-awesome-labs/spatula/commit/4f0d03375140c1407b21b3bd7f0779d342c8eb61))
* **api:** clear pre-existing TypeScript errors ([46cf144](https://github.com/accidentally-awesome-labs/spatula/commit/46cf144e51d4aa8d421d6c3a7e4fddaf8e809506))
* **auth:** extract JWT name/email for tenant naming, document owner constraint, add StorageError tests ([9837cc1](https://github.com/accidentally-awesome-labs/spatula/commit/9837cc177126140a62a7bc49309c81ee55fbad5f))
* **auth:** make auto-tenant creation idempotent with try/catch + re-query ([c0fa513](https://github.com/accidentally-awesome-labs/spatula/commit/c0fa5137712ad902100340a3031430f885efae03))
* **carveout:** drop dead stripe dep + scrub remaining billing-keyword comments (CARVE-04 final gate) ([3e7610b](https://github.com/accidentally-awesome-labs/spatula/commit/3e7610be4fffd29344d7fe685abe3642f31c587f))
* **ci:** clear lint errors exposed on main (no-unused-vars + import-type) ([07ec58c](https://github.com/accidentally-awesome-labs/spatula/commit/07ec58c04ac411b0da146dfa2d827813ecd0d30e))
* **db:** composite cursor for EntitySourceRepository.findByJobCursor ([9a19bc2](https://github.com/accidentally-awesome-labs/spatula/commit/9a19bc2917058667892ab6eec907503a4e7127c5))
* resolve pre-existing TypeScript build errors across API and CLI ([74ba6a3](https://github.com/accidentally-awesome-labs/spatula/commit/74ba6a328e95593fc87b602f5383debe84be51f2))
* return 404 (not 500) for cross-tenant action approve/reject ([bb7da95](https://github.com/accidentally-awesome-labs/spatula/commit/bb7da954bbbead30f9010c79b67eb06854166d29))
* update api-key test mock to include billing:read scope ([b37620f](https://github.com/accidentally-awesome-labs/spatula/commit/b37620f4bc2f9e97a170326a7086c359bd9fca46))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @spatula/core bumped to 0.1.0
    * @spatula/db bumped to 0.1.0
    * @spatula/queue bumped to 0.1.0
    * @spatula/shared bumped to 0.1.0
