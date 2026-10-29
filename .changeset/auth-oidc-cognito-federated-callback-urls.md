---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(core): read a registered config value and the shared API Gateway URL at synth

`@aws-blocks/core/cdk` exports two read-only helpers for first-party Building Blocks (marked `@internal`, not a stability-guaranteed API): `getRegisteredConfigValue(scope, key)` reads a value registered with `registerConfig`, and `getSharedGatewayUrl(scope)` returns the shared REST API's base URL. Both read at call time, so call them from a `cdk.Lazy` producer when the value is registered or built after the Building Block is constructed.
