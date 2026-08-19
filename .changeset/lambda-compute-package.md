---
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

feat: extract `LambdaCompute` into `@aws-blocks/bb-lambda-compute`

The abstract `Compute` base stays in core as a framework primitive; the concrete
`LambdaCompute` (a `NodejsFunction` fronted by its own API Gateway, assuming the
shared execution role) moves into a new package, `@aws-blocks/bb-lambda-compute`.

The package is CDK-only and its sole export is internal — customers cannot
instantiate a compute yet. Nothing in the default path constructs it, so this is
additive and non-breaking.
