---
"@aws-blocks/core": minor
"@aws-blocks/bb-realtime": patch
---

Add a shared, stack-wide infrastructure-hardening defaults mechanism and make bb-realtime its first adopter.

`@aws-blocks/core/cdk` now exposes `HardeningDefaults` plus `registerStackHardeningDefaults`/`getStackHardeningDefaults` and `resolve*` helpers. `BlocksStack`/`BlocksBackend` accept a `hardening` prop so an entire app can set defaults for log retention, API Gateway throttling, API access logging, and DynamoDB point-in-time recovery in one place. Blocks resolve each value as `perBlockOption ?? stackDefault ?? frameworkSecureDefault`, so a safe default applies with no configuration and any block can still override locally.

bb-realtime now applies these defaults to its WebSocket API stage: request throttling (default 100 req/s, 200 burst) and structured CloudWatch access logs (default retention 1 month) that were previously absent. Both are overridable via the stack-level `hardening` prop.
