---
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/core": patch
---

`LambdaCompute` now reports `bbName`/`bbVersion` to `Scope`, so it appears in telemetry like other Building Blocks. `LambdaCompute` is intentionally absent from the umbrella's vendorize map, so `scripts/generate-bb-names.mjs` now adds it to `OFFICIAL_BB_NAMES` explicitly. The CDK entry point is unchanged, since the CDK `Scope` does not register blocks for telemetry.
