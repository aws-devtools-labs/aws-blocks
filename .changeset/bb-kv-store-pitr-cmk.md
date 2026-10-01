---
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/blocks": minor
---

fix(bb-kv-store): wire point-in-time recovery from the stack preset and add customer-managed encryption

`KVStore` now honors `defaults.pointInTimeRecovery` (PITR on under `production`, off under `sandbox`) and accepts per-block `pointInTimeRecovery` and `encryption` options — mirroring `DistributedTable`. `encryption: 'customer-managed'` provisions a dedicated CMK, and `KVStore.fromKmsKey(arn)` reuses an existing key across stores. Previously `KVStore` ignored the preset, so production-preset consumers believed PITR was enabled when it was not.

The default encryption now emits the AWS-managed `aws/dynamodb` KMS key (`SSESpecification: { SSEEnabled: true }`), where before no `SSESpecification` was emitted at all (the AWS-owned key). On an already-deployed table this is an in-place SSE change applied on upgrade, and the `aws/dynamodb` key bills per-request KMS charges that the AWS-owned key does not.
