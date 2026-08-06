---
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

`Metrics`, `Tracer`, and `DistributedDatabase` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

All three were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but none passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name them, so `product.buildingBlocks` under-reported them. Each package now carries the standard `prebuild` (`generate-version.mjs Metrics` / `Tracer` / `DistributedDatabase`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

`bb-tracer` and `bb-distributed-data` ship distinct mock implementations (their default entry does not re-export the AWS class), so both `index.aws.ts` and `index.mock.ts` carry the change; `bb-metrics`'s mock re-exports the AWS class, so its single runtime change covers both conditions. CDK entry points are deliberately left alone — telemetry is reported by the runtime class, not the synth-time construct.

This is a follow-up to #298 (`AuthBasic`/`Logger`), completing telemetry parity for every vendorized block whose runtime class extends `Scope`. `@aws-blocks/blocks` takes a `patch` because it re-exports all three; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own. `@aws-blocks/core` needs no bump — all three names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.
