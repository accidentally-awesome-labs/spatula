# @spatula/queue

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an internal Spatula implementation package. Breaking changes to its TypeScript surface may land in any **MINOR** release. External consumers should not import it directly. The public packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, and `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

BullMQ workers, job manager, webhook delivery, and DLQ handling for Spatula. Orchestrators in `@spatula/core` stay pure; this package adapts them to the BullMQ runtime. Designed for Temporal/Inngest swap-out behind the same interfaces.

## Stability

**No stable TS-API.** Use `@spatula/client` for programmatic API access. Webhook retry schedule and HMAC verification are documented in [`docs/cookbook/webhooks.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/cookbook/webhooks.md).

## Compatibility

The TypeScript API is internal and may change between minor versions. Public compatibility guarantees live in `docs/compat-policy.md`.
