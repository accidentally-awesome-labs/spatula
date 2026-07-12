# Changelog

## [0.1.0](https://github.com/accidentally-awesome-labs/spatula/compare/shared-v0.0.1...shared-v0.1.0) (2026-07-12)


### Features

* **16-1:** add frozen ErrorCode enum + DOMAIN.CODE subclasses in @spatula/shared ([9a7f86e](https://github.com/accidentally-awesome-labs/spatula/commit/9a7f86e873b20f758b190c2ccd706b5ceeadbe2d))
* **16-2:** create @spatula/core-types package with frozen ErrorCode + schemas + enums ([cd07820](https://github.com/accidentally-awesome-labs/spatula/commit/cd0782052c7e6d73faa98baadb30b7746043de0f))
* **16-5:** extend release-please to 8 packages + linked-versions + node-workspace plugins ([76a030a](https://github.com/accidentally-awesome-labs/spatula/commit/76a030af9b4558594f39d6513e07c79053c0ee54))
* **18-02:** shared redactor module + unit tests ([28d29e0](https://github.com/accidentally-awesome-labs/spatula/commit/28d29e0e90b5abf60143234b1519e7e23f85e4c4))
* **18-02:** wire redactor into pino logger + OTel span processor ([a23aaab](https://github.com/accidentally-awesome-labs/spatula/commit/a23aaabfd313b72d016e6e11d016a9e5972d30e5))
* **18-02:** wire redactor into Sentry + per-sink redaction test suite ([b1bf3c0](https://github.com/accidentally-awesome-labs/spatula/commit/b1bf3c0e2be790c96ca5484105a4e8f5f7fb0db5))
* **18-05:** admin:forensic:read scope + forensic endpoint + OpenAPI experimental (SEC-05) ([adb17dc](https://github.com/accidentally-awesome-labs/spatula/commit/adb17dc433e6bea264f2b7a450d69c847721aaa1))
* **auth:** add strategy field to AuthResult, stop requiring tenant_id in JWT ([736cf59](https://github.com/accidentally-awesome-labs/spatula/commit/736cf5952c10f03d5d5c75dd0684104ede9afb2b))
* **carveout:** confirm SQLite schema has no billing coupling ([7d2e818](https://github.com/accidentally-awesome-labs/spatula/commit/7d2e8186239b2facc21aa4563bf4d8c83e157530))
* **carveout:** delete Section A billing files from OSS (history preserved in spatula-saas) ([20318a6](https://github.com/accidentally-awesome-labs/spatula/commit/20318a66f7da62cd5e484cdeb32a2dd20b953243))
* **carveout:** remove billing module + tier presets + billing scopes + TenantQuotas.rateLimitTier ([d123093](https://github.com/accidentally-awesome-labs/spatula/commit/d123093782d66c479b7af21cdf3352b6971c14f7))
* **shared:** add billing tier constants and types ([220ae2c](https://github.com/accidentally-awesome-labs/spatula/commit/220ae2c290bd09da0b57f7a99e76b171294a5aa8))
* **shared:** add webhook event types and config ([7bc277a](https://github.com/accidentally-awesome-labs/spatula/commit/7bc277abc53fdeb16e61e976ec9f4af3c7b417eb))
* **shared:** register observable gauges for active_jobs, tenant_count, queue_depth ([852f9e1](https://github.com/accidentally-awesome-labs/spatula/commit/852f9e124a9692981bff86695d6b3ce1e1adba8e))
* Wave 5-6 — deferred items (10 items, 16 commits) ([413ac19](https://github.com/accidentally-awesome-labs/spatula/commit/413ac1992a1b33feea8081e60ccdd08c2cf13146))


### Bug Fixes

* **15-ci:** get PR CI green — format pass, lint cleanup, workflow fixes ([918f364](https://github.com/accidentally-awesome-labs/spatula/commit/918f3649e216204971fe9c12b00e8a39d70c980a))
* address deferred review findings ([2398ce7](https://github.com/accidentally-awesome-labs/spatula/commit/2398ce7e75e182ae2a58e3de5f2408975fbc8be0))
* address spec compliance review findings ([1c0e869](https://github.com/accidentally-awesome-labs/spatula/commit/1c0e8699069fa788409254065a4e483d2f55830e))
* **auth:** extract JWT name/email for tenant naming, document owner constraint, add StorageError tests ([9837cc1](https://github.com/accidentally-awesome-labs/spatula/commit/9837cc177126140a62a7bc49309c81ee55fbad5f))
* **docs:** address code review findings for Wave 5-2 plan — add billing scopes, fix cross-package import, document race condition, add missing exports ([a4c3510](https://github.com/accidentally-awesome-labs/spatula/commit/a4c35103f0ab1e1ade1e9737499b37af3c5130f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @spatula/core-types bumped to 0.1.0
