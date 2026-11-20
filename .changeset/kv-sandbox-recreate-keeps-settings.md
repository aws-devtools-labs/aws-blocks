---
'@aws-cdk-blocks/bb-kv-store': patch
'aws-cdk-blocks': patch
---

Sandbox: when the index manager recreates the table of a store with indexes, the new table keeps the old table's encryption key, TTL, tags, point-in-time recovery, stream, and table class, and items that DynamoDB returns as unprocessed are written again. A table that an earlier version recreated without its encryption, TTL, or point-in-time recovery is recreated with them on the next deploy. A sandbox table with `protection: 'locked'` is no longer deleted, and its indexes change one at a time. A key from `KVStore.fromKmsKey()` must allow the index manager's role in its key policy. The index manager's log no longer includes CloudFormation's response URL.
