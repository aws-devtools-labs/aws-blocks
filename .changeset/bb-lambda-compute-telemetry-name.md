---
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

`LambdaCompute` now reports `bbName`/`bbVersion` to `Scope`, and the umbrella registers the Lambda default compute on import, so it appears in telemetry like other Building Blocks. `LambdaCompute` is intentionally absent from the umbrella's vendorize map, so `scripts/generate-bb-names.mjs` adds it to `OFFICIAL_BB_NAMES` explicitly.
