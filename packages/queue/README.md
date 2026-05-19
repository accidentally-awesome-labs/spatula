# @spatula/queue

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an **INTERNAL** Spatula package published to npm so the private `spatula-saas` repo can install it. Breaking changes to its TypeScript surface may land in any **MINOR** release. Outside consumers should not rely on it. The PUBLIC packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

BullMQ workers, job manager, webhook delivery, and DLQ handling for Spatula. Orchestrators in `@spatula/core` stay pure; this package adapts them to the BullMQ runtime. Designed for Temporal/Inngest swap-out behind the same interfaces.

## Stability

**No stable TS-API.** Use `@spatula/client` for programmatic API access. Webhook retry schedule and HMAC verification are documented in [`docs/cookbook/webhooks.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/cookbook/webhooks.md).

## Compatibility

This package is published to satisfy the private `spatula-saas` `import { ... } from '@spatula/queue'` contract documented in [`docs/private-contract.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/private-contract.md). Forward-contract enforcement lives in `tests/private-contract/`.
