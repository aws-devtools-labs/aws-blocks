---
"@aws-blocks/core": patch
---

Apply a default request throttle (200 rps / 400 burst) to the Blocks API Gateway stage instead of inheriting the AWS account default of 10,000 rps. Override it with the new optional `throttling` prop on `BlocksBackendProps` for high-traffic deployments.
