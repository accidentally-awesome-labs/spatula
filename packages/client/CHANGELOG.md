# Changelog

## [0.1.0](https://github.com/accidentally-awesome-labs/spatula/compare/client-v0.0.1...client-v0.1.0) (2026-06-11)


### Features

* **16-2:** create @spatula/client SDK package with codegen + size-limit gate ([c65ad81](https://github.com/accidentally-awesome-labs/spatula/commit/c65ad81b853032fff8fc1c8bcf53455a8f77db59))
* **16-3:** add lazy version probe in @spatula/client (D-12) ([fdc74ae](https://github.com/accidentally-awesome-labs/spatula/commit/fdc74aecd4041adc1d1790c80756462844f2353a))
* **16-5:** SDK integration test suite — 5 endpoints, mocked default, SPATULA_LIVE_LLM=1 opt-in ([f958c43](https://github.com/accidentally-awesome-labs/spatula/commit/f958c43d63fa8e54c8194e8f0afd97c76875fa3e))
* **17-06:** replace getJobEvents stub with real SSE subscribeJobEvents method ([1688500](https://github.com/accidentally-awesome-labs/spatula/commit/1688500d4b90116567c62dbafee61dd8017b3c50))
* **18-05:** SDK client.experimental.forensic.listExtractions surface (SEC-05) ([df76455](https://github.com/accidentally-awesome-labs/spatula/commit/df76455bea8f87c973bfaae620b172c06f6e7afe))
* **carveout:** confirm SQLite schema has no billing coupling ([7d2e818](https://github.com/accidentally-awesome-labs/spatula/commit/7d2e8186239b2facc21aa4563bf4d8c83e157530))


### Bug Fixes

* **17-06:** repair browser e2e OIDC flow — localhost IPv6 collision, scope grant, repo wiring, event publishing, SSE id injection ([69280ec](https://github.com/accidentally-awesome-labs/spatula/commit/69280ec7b4b526b94a341d5d3f07152b21a4f63f))
* **ci:** clear lint errors exposed on main (no-unused-vars + import-type) ([07ec58c](https://github.com/accidentally-awesome-labs/spatula/commit/07ec58c04ac411b0da146dfa2d827813ecd0d30e))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @spatula/core-types bumped to 0.1.0
    * @spatula/shared bumped to 0.1.0
  * peerDependencies
    * @spatula/core-types bumped from 0.x to 0.1.0
