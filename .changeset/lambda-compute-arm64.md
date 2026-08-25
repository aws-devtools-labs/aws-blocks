---
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/blocks": patch
---

`LambdaCompute`: default the function to **arm64 (AWS Graviton)**, with an `architecture` override.

The compute's Lambda now defaults to `Architecture.ARM_64` instead of CDK's `x86_64` default. arm64 Lambda is ~20% cheaper per GB-second than x86_64 at equivalent performance, and the Blocks backend is a pure-JavaScript esbuild bundle with no architecture-specific native dependencies, so the switch carries no runtime risk. Because `LambdaCompute` is the default compute for every `@aws-blocks/blocks` app, the shared handler runs on Graviton out of the box.

Adds `architecture?: Architecture` to `LambdaComputeProps` to override it (e.g. `Architecture.X86_64` when bundling an x86-only native addon).

> **Behavior change on next deploy:** the handler function's architecture is `arm64` (an in-place update on an existing function).
