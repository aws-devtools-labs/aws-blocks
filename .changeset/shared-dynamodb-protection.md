---
"@aws-blocks/core": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/blocks": patch
---

refactor(core, bb-kv-store, bb-distributed-table): share one DynamoDB PITR + encryption resolver

No synth output change: the same CloudFormation template and the same synth warnings are produced.

The point-in-time-recovery and encryption resolution — the `retentionDays` 1–35 validation, the `aws-managed`/`customer-managed`/`fromKmsKey` encryption selection, and the auto-created-CMK removal-policy alignment — was duplicated almost line-for-line between the two Blocks-provisioned DynamoDB tables (`bb-kv-store`, `bb-distributed-table`). Both blocks now resolve that behaviour through one shared internal helper in `@aws-blocks/core`. Durability (`removalPolicy`/`deletionProtection`) stays in each block, since the two surface it through different options.
