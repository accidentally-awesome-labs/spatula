# Changelog

## [0.1.0](https://github.com/accidentally-awesome-labs/spatula/compare/core-v0.0.1...core-v0.1.0) (2026-07-12)


### Features

* **16-2:** create @spatula/core-types package with frozen ErrorCode + schemas + enums ([cd07820](https://github.com/accidentally-awesome-labs/spatula/commit/cd0782052c7e6d73faa98baadb30b7746043de0f))
* **16-5:** extend release-please to 8 packages + linked-versions + node-workspace plugins ([76a030a](https://github.com/accidentally-awesome-labs/spatula/commit/76a030af9b4558594f39d6513e07c79053c0ee54))
* **18-01:** adversarial suite + CI lane + issue template + corpus-refresh doc (SEC-02, SEC-03) ([d49fceb](https://github.com/accidentally-awesome-labs/spatula/commit/d49fcebbf18ea61575bb17974404162bb52b565c))
* **18-01:** apply 7 prompt-injection mitigations to StaticExtractor (SEC-01) ([d2e83e3](https://github.com/accidentally-awesome-labs/spatula/commit/d2e83e31aa74e7738862ae9b54fe06c941671928))
* **18-01:** output-content scanner + pinned-models + adversarial fixtures ([6fb1edf](https://github.com/accidentally-awesome-labs/spatula/commit/6fb1edf6ec8dbd61170bb050c5679601ea627068))
* **18-04:** README legal banner + default User-Agent crawler-defaults (LEGAL-07/08) ([a7088da](https://github.com/accidentally-awesome-labs/spatula/commit/a7088da84fe6ccfb348cc9cd5cd8d7188d0a0cba))
* **18-05:** forensic archiver + StaticExtractor wiring (SEC-04) ([1a42073](https://github.com/accidentally-awesome-labs/spatula/commit/1a420733a55c49bda086521f763e6aed609e0353))
* add health check framework, system/server checks, and spatula doctor ([e16b4b4](https://github.com/accidentally-awesome-labs/spatula/commit/e16b4b40ea8ab3773974900fdfc73b8178bd86ce))
* **api:** add billing routes (subscription, invoices, portal) and wire AppDeps ([053dbc4](https://github.com/accidentally-awesome-labs/spatula/commit/053dbc44854fe8f54e985fc4c277675eeb893227))
* **billing:** wire QuotaEnforcer into job-manager (jobs), crawl worker (pages), LLM recorder (tokens), export orchestrator (storage) ([4da065f](https://github.com/accidentally-awesome-labs/spatula/commit/4da065faec12fa2d724a2ec5b6b52e832d01ccb1))
* **carveout:** confirm SQLite schema has no billing coupling ([7d2e818](https://github.com/accidentally-awesome-labs/spatula/commit/7d2e8186239b2facc21aa4563bf4d8c83e157530))
* **carveout:** delete Section A billing files from OSS (history preserved in spatula-saas) ([20318a6](https://github.com/accidentally-awesome-labs/spatula/commit/20318a66f7da62cd5e484cdeb32a2dd20b953243))
* **carveout:** remove QuotaEnforcer coupling from queue + core + api layers ([c449fcd](https://github.com/accidentally-awesome-labs/spatula/commit/c449fcdb2ebb8265bd3462f7e2a83e114c236fda))
* **core:** add 8 project-level health checks for spatula doctor ([9ebf143](https://github.com/accidentally-awesome-labs/spatula/commit/9ebf1431011571981776af146b74a295e92134d8))
* **core:** add CssExtractor for offline CSS-only extraction + wire into test-url ([e714fde](https://github.com/accidentally-awesome-labs/spatula/commit/e714fde0a1b13b49946f97585b839255e7f8ee1a))
* **core:** add QuotaEnforcer service for billing dimension checks ([2c04cfe](https://github.com/accidentally-awesome-labs/spatula/commit/2c04cfed577f1a59fbf4bb97a8bc29e4574eab76))
* **core:** add recursive objectFields/arrayItemType comparison to config diff ([d969f09](https://github.com/accidentally-awesome-labs/spatula/commit/d969f09129309cf7d7f8b15fa0118b28472dcfe0))
* **core:** add saveGlobalConfig utility with merge support ([6d08bbc](https://github.com/accidentally-awesome-labs/spatula/commit/6d08bbc97b81a57c9c8497e2e76bdafe01969564))
* **core:** add table extraction to css-extractor ([1c7b362](https://github.com/accidentally-awesome-labs/spatula/commit/1c7b362dcc9de5875ff48ea431b3ec1d03dcabe5))
* **core:** extract cost from OpenRouter x-openrouter-cost response header ([22c2e69](https://github.com/accidentally-awesome-labs/spatula/commit/22c2e695ea61dc23c211aafb4f67af597e7410fe))
* flip default LLM model to deepseek/deepseek-v4-pro + add pricing ([342729e](https://github.com/accidentally-awesome-labs/spatula/commit/342729eff64d59c62236e6e81750336111b45495))
* Wave 5-6 — deferred items (10 items, 16 commits) ([413ac19](https://github.com/accidentally-awesome-labs/spatula/commit/413ac1992a1b33feea8081e60ccdd08c2cf13146))
* wire config diff and re-extraction into LocalPipelineRunner ([b3e51d9](https://github.com/accidentally-awesome-labs/spatula/commit/b3e51d9be342a880e31b78d794be8a24fdc546a4))


### Bug Fixes

* **15-03:** clean up post-carveout lint residue ([9785066](https://github.com/accidentally-awesome-labs/spatula/commit/9785066b6078cfd6f005824cb24fca3aa23e7f08))
* **15-ci:** get PR CI green — format pass, lint cleanup, workflow fixes ([918f364](https://github.com/accidentally-awesome-labs/spatula/commit/918f3649e216204971fe9c12b00e8a39d70c980a))
* address spec compliance review findings ([1c0e869](https://github.com/accidentally-awesome-labs/spatula/commit/1c0e8699069fa788409254065a4e483d2f55830e))
* address Wave 4-1 code quality review findings ([f97c5f7](https://github.com/accidentally-awesome-labs/spatula/commit/f97c5f7813ff20e73eefc9e98b0b63c5db5f3639))
* address Wave 4-2 code quality review findings ([a0c9ded](https://github.com/accidentally-awesome-labs/spatula/commit/a0c9ded02c9cdae499d2e99004f814fc5b89d430))
* **ci:** clear lint errors exposed on main (no-unused-vars + import-type) ([07ec58c](https://github.com/accidentally-awesome-labs/spatula/commit/07ec58c04ac411b0da146dfa2d827813ecd0d30e))
* remove unused expect import in example-configs test ([159070a](https://github.com/accidentally-awesome-labs/spatula/commit/159070a704a311cad7d9a0118fde8c8565c2dafc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @spatula/core-types bumped to 0.1.0
    * @spatula/shared bumped to 0.1.0
