# Changelog

## [0.1.0](https://github.com/accidentally-awesome-labs/spatula/compare/db-v0.0.1...db-v0.1.0) (2026-07-12)


### Features

* **16-5:** extend release-please to 8 packages + linked-versions + node-workspace plugins ([76a030a](https://github.com/accidentally-awesome-labs/spatula/commit/76a030af9b4558594f39d6513e07c79053c0ee54))
* **16-5:** SQLite benchmark + docs/architecture.md decision (SDK-05) ([8aab113](https://github.com/accidentally-awesome-labs/spatula/commit/8aab11345ad0fa0526ce04a116b43802fd0e6757))
* **17-01:** add supersedes columns to api_keys via Drizzle migration ([048330c](https://github.com/accidentally-awesome-labs/spatula/commit/048330c04e3d1f71c59d276d1cfa9f22e709183c))
* **17-04:** add ApiKeyRepository.rotate() — transactional new-key + grace-expire ([151eded](https://github.com/accidentally-awesome-labs/spatula/commit/151eded71266c06bb607e3a436b0c11e1fd3ec38))
* **18-06:** TenantDataRepository — cascade delete + audit redaction + tombstone ([34840dc](https://github.com/accidentally-awesome-labs/spatula/commit/34840dc028a11d571c5f687a360b67dd8e679e3e))
* **api:** add pageUrl to extractions, entity-sources endpoint, job stats enrichment ([da98cba](https://github.com/accidentally-awesome-labs/spatula/commit/da98cbad19e4d00642fa997a417b9d205995cb89))
* **carveout:** confirm SQLite schema has no billing coupling ([7d2e818](https://github.com/accidentally-awesome-labs/spatula/commit/7d2e8186239b2facc21aa4563bf4d8c83e157530))
* **carveout:** delete Section A billing files from OSS (history preserved in spatula-saas) ([20318a6](https://github.com/accidentally-awesome-labs/spatula/commit/20318a66f7da62cd5e484cdeb32a2dd20b953243))
* **carveout:** drop plan + stripeCustomerId columns from tenants schema + repo ([e88d322](https://github.com/accidentally-awesome-labs/spatula/commit/e88d322db96d2c893abc862cf759d62b5d6994c3))
* **carveout:** namespace OSS migrations via __drizzle_migrations_oss tracking table ([6ea4fb7](https://github.com/accidentally-awesome-labs/spatula/commit/6ea4fb7a7669c4736b77e8b9cb6cd14539843a2a))
* **carveout:** remove usage_records schema + repo exports ([e4e9bbc](https://github.com/accidentally-awesome-labs/spatula/commit/e4e9bbc5b084d54ee1de65701f677835e4c9da6b))
* **carveout:** squash 12 migrations into 0000_v1_baseline for v1.0 ([4427c80](https://github.com/accidentally-awesome-labs/spatula/commit/4427c80e39ba5fbc7baed8713b3e4713d94b0a13))
* **cli:** add crawl history dedup to spatula add with --no-history bypass ([6c695c8](https://github.com/accidentally-awesome-labs/spatula/commit/6c695c8808bf9e661824a6d5f9583dd8069380f7))
* **db:** add cross-tenant findAll, countAll, and forceCancel to JobRepository ([b9bad11](https://github.com/accidentally-awesome-labs/spatula/commit/b9bad11d6155645ca1c0affbed507a9ccc95bfd3))
* **db:** add delete and deleteByPrefix to ProjectMetaRepository ([72e91ff](https://github.com/accidentally-awesome-labs/spatula/commit/72e91ff40a321c3649d0f7bf6dcac10313bced58))
* **db:** add findAll, countAll, and getTotalStorage to TenantRepository ([af35a71](https://github.com/accidentally-awesome-labs/spatula/commit/af35a713a62cb6939d795fcb0aacd158acb3aee4))
* **db:** add nullable runId column to SQLite entities table with migration ([6041d2a](https://github.com/accidentally-awesome-labs/spatula/commit/6041d2ae840368782192e7dcb3db741d34dbac14))
* **db:** add plan and stripe_customer_id columns to tenants table ([6f3fd29](https://github.com/accidentally-awesome-labs/spatula/commit/6f3fd29d9db429d853ac1cd595f4eba41c8096a8))
* **db:** add pull-flow methods to SQLite entity and run repos ([2810342](https://github.com/accidentally-awesome-labs/spatula/commit/28103429a13676ab1a88a39bd82f4bf159fa1982))
* **db:** add runId/pageUrl columns to SQLite extractions and actions for pull flow ([dd61157](https://github.com/accidentally-awesome-labs/spatula/commit/dd6115726b75f45922a5d4e94ec71dea354d78b5))
* **db:** add upsertBatch/deleteByRunIds for extractions, actions, entity sources ([a476429](https://github.com/accidentally-awesome-labs/spatula/commit/a476429ad2b168848bd15cde5489950008db069b))
* **db:** add usage_records schema and UsageRecordRepository ([b2dd047](https://github.com/accidentally-awesome-labs/spatula/commit/b2dd047c915dd4ac02745a1c1a20260dc77bdbcc))
* **db:** add user_tenants schema and migration ([1fbe38b](https://github.com/accidentally-awesome-labs/spatula/commit/1fbe38bd205afd51c20718c54fcd24d60ecba65a))
* **db:** add UserTenantRepository with CRUD operations ([6701018](https://github.com/accidentally-awesome-labs/spatula/commit/670101843c9c019c9e0cb1971145fa8351b8ac7b))
* Wave 5-6 — deferred items (10 items, 16 commits) ([413ac19](https://github.com/accidentally-awesome-labs/spatula/commit/413ac1992a1b33feea8081e60ccdd08c2cf13146))
* wire config diff and re-extraction into LocalPipelineRunner ([b3e51d9](https://github.com/accidentally-awesome-labs/spatula/commit/b3e51d9be342a880e31b78d794be8a24fdc546a4))


### Bug Fixes

* **15-04:** use nested drizzle-kit migrations.table key ([4a2c8a3](https://github.com/accidentally-awesome-labs/spatula/commit/4a2c8a302d94ce5ec29e8a82b5087867b5752340))
* **15-ci:** get PR CI green — format pass, lint cleanup, workflow fixes ([918f364](https://github.com/accidentally-awesome-labs/spatula/commit/918f3649e216204971fe9c12b00e8a39d70c980a))
* **15-ci:** normalize pg_dump OWNER + access-method noise, bump db exports timeout ([bc8292f](https://github.com/accidentally-awesome-labs/spatula/commit/bc8292fa77792fec409164b668b128c236b30d64))
* **15-followup:** retire post-merge pg_dump gate + bump CI-flaky test timeouts ([95f0127](https://github.com/accidentally-awesome-labs/spatula/commit/95f0127a6715cbb8ee8fb5d0550cff04fab4dfe9))
* address code review findings — validate plan from Stripe, add stripe_customer_id index, fix idempotency key, safe metering deps construction ([bf6ee6c](https://github.com/accidentally-awesome-labs/spatula/commit/bf6ee6c107d979f92b8975f51cda1dcf28327ca6))
* address deferred review findings ([2398ce7](https://github.com/accidentally-awesome-labs/spatula/commit/2398ce7e75e182ae2a58e3de5f2408975fbc8be0))
* **auth:** extract JWT name/email for tenant naming, document owner constraint, add StorageError tests ([9837cc1](https://github.com/accidentally-awesome-labs/spatula/commit/9837cc177126140a62a7bc49309c81ee55fbad5f))
* **carveout:** preserve content_store CHECK constraints in v1 baseline ([8d5db6c](https://github.com/accidentally-awesome-labs/spatula/commit/8d5db6c8e4828b6325c547218a362a0c7b144082))
* **db:** auto-apply migrations in integration test beforeAll ([f101936](https://github.com/accidentally-awesome-labs/spatula/commit/f1019369f93f0dd757221698eca46b0605776bf2))
* **db:** cast findByJob return to satisfy ExtractionRepo interface after pageId nullable change ([adfe5f6](https://github.com/accidentally-awesome-labs/spatula/commit/adfe5f607473cfbcb17b1c1ea0d565f49ca4e541))
* **db:** centralize test migrations via vitest globalSetup ([a492c7f](https://github.com/accidentally-awesome-labs/spatula/commit/a492c7f9c9db62ecf2ac7cd22f73a54ce7afba79))
* **db:** composite cursor for EntitySourceRepository.findByJobCursor ([9a19bc2](https://github.com/accidentally-awesome-labs/spatula/commit/9a19bc2917058667892ab6eec907503a4e7127c5))
* **db:** correctly count within-batch duplicate IDs as updates in upsertBatch ([c1d7b1c](https://github.com/accidentally-awesome-labs/spatula/commit/c1d7b1c9e649c39510425d8e94356b71223b471f))
* **db:** replace count-based upsertBatch/deleteByRunIds with precise tracking ([339c748](https://github.com/accidentally-awesome-labs/spatula/commit/339c748dcf04810d7a86290a472b4a3c79fe454a))
* **db:** within-batch dup count in extraction + action upsertBatch ([a39dc2d](https://github.com/accidentally-awesome-labs/spatula/commit/a39dc2d708af31578713d617b2f8e09dbfe7a930))
* resolve 6 Tier 5A test failures against real Docker Postgres + Redis ([367728d](https://github.com/accidentally-awesome-labs/spatula/commit/367728dd10fbe2a36deca7a7716e3ba009c6c61d))


### Performance Improvements

* **db:** add index on entities.runId for pull-flow queries ([03504b3](https://github.com/accidentally-awesome-labs/spatula/commit/03504b3e1a644707ca05f56a1f036b93a85d9164))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @spatula/core bumped to 0.1.0
    * @spatula/shared bumped to 0.1.0
