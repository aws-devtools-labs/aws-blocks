---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": minor
---

Move the backend's API Gateway REST API out of the compute and into a single stack-level shared gateway.

`BlocksStack` / `BlocksBackend` now build one shared REST API at finalize time and integrate the default compute's function through the new `Compute.apiHandler()` contract, instead of each `LambdaCompute` creating its own gateway. This is the seam multi-compute routing builds on: one gateway can front every compute in the app. The gateway is built in the default compute's construct scope with the same construct ids as before, so a deployed app's REST API, stage, and `execute-api` URL are unchanged on upgrade. `BlocksStack.gateway` / `apiUrl` (and `BlocksBackend`'s) keep their types and values. Throttling and access logging behave as before.

`LambdaCompute` no longer exposes `apiGateway` / `apiUrl` (the package is internal and not customer-facing); read them from the stack's `gateway` / `apiUrl`.
