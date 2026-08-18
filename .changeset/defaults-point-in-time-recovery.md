---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

Add `pointInTimeRecovery: boolean` to `BlocksDefaults` (and to `BlocksPresets`: `true` in `production`, `false` in `sandbox`).

This extends the stack-wide infrastructure-defaults posture with the continuous-backup knob, so a Building Block whose service supports it (DynamoDB Point-in-Time Recovery) can resolve its default from `scope.defaults.pointInTimeRecovery` — read independently, the same way as `removalPolicy` and `deletionProtection`. Blocks whose service has no equivalent simply ignore it. `bb-distributed-table` is the first consumer.

> The property **name** (`pointInTimeRecovery`) is a public `@aws-blocks/core/cdk` surface addition and wants API-BR sign-off before release.
