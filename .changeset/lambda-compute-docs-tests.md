---
'@aws-blocks/bb-lambda-compute': patch
'@aws-blocks/blocks': patch
---

Update the `LambdaCompute` README and design doc to describe how the compute reaches an app (as the default compute and through `Compute` with `type: 'serverless'`), its options, and its VPC, CORS, tracing, and dashboard behavior. Add tests for the memory, timeout, and VPC placement settings.
