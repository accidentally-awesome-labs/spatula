# Changelog

## [0.1.0](https://github.com/accidentally-awesome-labs/spatula/compare/queue-v0.0.1...queue-v0.1.0) (2026-07-12)


### Features

* **16-1:** add frozen ErrorCode enum + DOMAIN.CODE subclasses in @spatula/shared ([9a7f86e](https://github.com/accidentally-awesome-labs/spatula/commit/9a7f86e873b20f758b190c2ccd706b5ceeadbe2d))
* **16-5:** extend release-please to 8 packages + linked-versions + node-workspace plugins ([76a030a](https://github.com/accidentally-awesome-labs/spatula/commit/76a030af9b4558594f39d6513e07c79053c0ee54))
* **17-02:** dual-publish events to Redis Stream in RedisEventPublisher ([c2f3b59](https://github.com/accidentally-awesome-labs/spatula/commit/c2f3b591b3cefd754823d01490729fc478686ab9))
* **18-06:** tenant-delete BullMQ queue + cascade worker (idempotent + fail-loud) ([0a77bec](https://github.com/accidentally-awesome-labs/spatula/commit/0a77becba35801c4dc7486a27d82f889ca6da00b))
* **19-01:** export startWorker() lifecycle handle from queue package ([280db73](https://github.com/accidentally-awesome-labs/spatula/commit/280db738b046c3dcf775921240d79f7d0d637647))
* **19-02:** distroless api + worker runtime images (DEPLOY-03) ([92dd2dd](https://github.com/accidentally-awesome-labs/spatula/commit/92dd2ddd985d772e25abb8df49aacbb8a0a4347b))
* add @spatula/queue devDep, export createWebhookWorker, add tier 5a ([e7af7c1](https://github.com/accidentally-awesome-labs/spatula/commit/e7af7c1a2fb12d802b85a1efd8aeb4a7b8283ca7))
* add webhook config schema and enqueue helper ([d5764f1](https://github.com/accidentally-awesome-labs/spatula/commit/d5764f1bd54aaa5ad7fb5fa60bab29e45d54d4a5))
* **billing:** wire QuotaEnforcer into job-manager (jobs), crawl worker (pages), LLM recorder (tokens), export orchestrator (storage) ([4da065f](https://github.com/accidentally-awesome-labs/spatula/commit/4da065faec12fa2d724a2ec5b6b52e832d01ccb1))
* **carveout:** confirm SQLite schema has no billing coupling ([7d2e818](https://github.com/accidentally-awesome-labs/spatula/commit/7d2e8186239b2facc21aa4563bf4d8c83e157530))
* **carveout:** delete Section A billing files from OSS (history preserved in spatula-saas) ([20318a6](https://github.com/accidentally-awesome-labs/spatula/commit/20318a66f7da62cd5e484cdeb32a2dd20b953243))
* **carveout:** remove metering worker wiring + METERING queue name ([8b1dfb7](https://github.com/accidentally-awesome-labs/spatula/commit/8b1dfb792d050ba8b8eb70a81bc0c8485aef9b87))
* **carveout:** remove QuotaEnforcer coupling from queue + core + api layers ([c449fcd](https://github.com/accidentally-awesome-labs/spatula/commit/c449fcdb2ebb8265bd3462f7e2a83e114c236fda))
* **queue:** add audit logging for quota exceeded events in JobManager ([4ec94af](https://github.com/accidentally-awesome-labs/spatula/commit/4ec94af33fa9b1f7d9e7e53aed6070b37b529d0d))
* **queue:** add CLEANUP queue name constant ([b013098](https://github.com/accidentally-awesome-labs/spatula/commit/b01309885bf6f428637485368e01570ebd2aa17b))
* **queue:** add daily cleanup worker with three-phase FK-safe retention ([d59de51](https://github.com/accidentally-awesome-labs/spatula/commit/d59de51c4bf32364753b0686515270b6c0e2510a))
* **queue:** add hourly metering worker for Stripe usage reporting ([a4d8d97](https://github.com/accidentally-awesome-labs/spatula/commit/a4d8d9796dabe5ed3478a155f7c966c9082b4815))
* **queue:** add webhook queue, worker, and Bull Board registration ([8e1cc24](https://github.com/accidentally-awesome-labs/spatula/commit/8e1cc24e2ccc43726293e554c8c6916ce2990806))
* **queue:** add WebhookSender with HMAC-SHA256 signing ([b551493](https://github.com/accidentally-awesome-labs/spatula/commit/b551493281381ccb40e28f8180b8d926e70eeb90))
* **queue:** register cleanup worker in entrypoint (daily at 03:00 UTC) ([89c29ac](https://github.com/accidentally-awesome-labs/spatula/commit/89c29ac7c69bff519a1f1e6b606926d359bff302))
* Wave 5-6 — deferred items (10 items, 16 commits) ([413ac19](https://github.com/accidentally-awesome-labs/spatula/commit/413ac1992a1b33feea8081e60ccdd08c2cf13146))
* wire webhook events into 5 integration points + add worker tests ([4131483](https://github.com/accidentally-awesome-labs/spatula/commit/4131483648337dcbbb56e354164d58f818284b62))


### Bug Fixes

* **15-03:** clean up post-carveout lint residue ([9785066](https://github.com/accidentally-awesome-labs/spatula/commit/9785066b6078cfd6f005824cb24fca3aa23e7f08))
* **15-ci:** get PR CI green — format pass, lint cleanup, workflow fixes ([918f364](https://github.com/accidentally-awesome-labs/spatula/commit/918f3649e216204971fe9c12b00e8a39d70c980a))
* address code review findings — validate plan from Stripe, add stripe_customer_id index, fix idempotency key, safe metering deps construction ([bf6ee6c](https://github.com/accidentally-awesome-labs/spatula/commit/bf6ee6c107d979f92b8975f51cda1dcf28327ca6))
* address spec compliance review findings ([1c0e869](https://github.com/accidentally-awesome-labs/spatula/commit/1c0e8699069fa788409254065a4e483d2f55830e))
* **api:** clear pre-existing TypeScript errors ([46cf144](https://github.com/accidentally-awesome-labs/spatula/commit/46cf144e51d4aa8d421d6c3a7e4fddaf8e809506))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @spatula/core bumped to 0.1.0
    * @spatula/db bumped to 0.1.0
    * @spatula/shared bumped to 0.1.0
