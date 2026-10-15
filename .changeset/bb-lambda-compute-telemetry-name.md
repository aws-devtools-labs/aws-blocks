---
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

`LambdaCompute` now reports `bbName`/`bbVersion` to `Scope`, so it appears in telemetry like every other Building Block.

`LambdaCompute` passed no `bbName` to `Scope`, and `Scope` records a block in its registry only when `bbName` is set, so `Scope.getRegisteredBlocks()` could never name the default compute and `product.buildingBlocks` omitted it. The package already carried the standard `prebuild` (`generate-version.mjs LambdaCompute`), which generates the `BB_NAME`/`BB_VERSION` its constructor now passes through — the same wiring the other blocks use.

`LambdaCompute` has no customer-facing export, so it is deliberately absent from the umbrella's `aws-blocks.vendorize` map that `scripts/generate-bb-names.mjs` reads. The generator now also emits a `NON_VENDORIZED_BB_NAMES` list, adding it to `OFFICIAL_BB_NAMES` so it is reported as an official block rather than filtered as an unnamed custom one. `@aws-blocks/core` is bumped because that generated file changes; the `cdk` entry point is left alone, as telemetry is reported by the runtime class, not the synth-time construct.

The default compute is built only at CDK synth, in a child process whose registry no telemetry path reads, so nothing constructs one where telemetry is emitted. Importing `@aws-blocks/blocks` through its default (Node) entry now declares it instead: `Scope._setDefaultBlockForTelemetry` records its name and version, and `getRegisteredBlocks()` folds that in only when telemetry actually reads the registry.

Declaring rather than constructing keeps the import inert — a process that imports the umbrella and emits no telemetry leaves `totalCount` untouched — and the entry is appended after the blocks the app constructed, so it never displaces them in `product.buildingBlocks`. An app-constructed `LambdaCompute` takes precedence over the declaration, so it is never counted twice. `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.
