---
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/blocks": minor
---

fix(bb-kv-store): wire point-in-time recovery from the stack preset and add customer-managed encryption

`KVStore` now honors `defaults.pointInTimeRecovery` (PITR on under `production`, off under `sandbox`) and accepts per-block `pointInTimeRecovery` and `encryption` options — mirroring `DistributedTable`. `encryption: 'customer-managed'` provisions a dedicated CMK, and `KVStore.fromKmsKey(arn)` reuses an existing key across stores. Previously `KVStore` ignored the preset, so production-preset consumers believed PITR was enabled when it was not.

The default encryption now emits the AWS-managed `aws/dynamodb` KMS key (`SSESpecification: { SSEEnabled: true }`), where before no `SSESpecification` was emitted at all (the AWS-owned key). On an already-deployed table this is an in-place SSE change applied on upgrade, and the `aws/dynamodb` key bills per-request KMS charges that the AWS-owned key does not.

**Behavior change on next production deploy of an existing app:** an existing `production`-preset `KVStore` table gains Point-in-Time Recovery in place on the next deploy (an in-place update, no table replacement); continuous backups are billed per GB-month of table size. Separately, passing `removalPolicy`, `deletionProtection`, or `ttl` alongside `fromExisting()` now warns at synth (previously only `pointInTimeRecovery` and `encryption` did), so a pipeline running `cdk synth --strict` will fail until those options are removed from the wrapped-table call.
