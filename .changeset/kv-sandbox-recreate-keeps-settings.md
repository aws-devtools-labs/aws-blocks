---
'@aws-cdk-blocks/bb-kv-store': patch
'aws-cdk-blocks': patch
---

Sandbox: a store with indexes keeps its encryption, TTL, tags and point-in-time recovery when the index manager recreates its table. The new table gets the AWS-managed or customer-managed KMS key of the old one, TTL on the same attribute (`_bkv_ttl` or the store's `ttl` field), its user tags, point-in-time recovery with the same recovery period, and its stream and table class. A sandbox table with deletion protection (`protection: 'locked'`) is no longer deleted; its indexes change one at a time instead. In sandbox deployments the index manager's role gets the permissions to read and set these settings on its stores' tables, and to use a store's customer-managed key through DynamoDB. A key from `KVStore.fromKmsKey()` must allow that role in its key policy, for example by delegating to account IAM. A table that an earlier version already recreated keeps the settings it has now.
