---
'@aws-cdk-blocks/bb-kv-store': patch
'aws-cdk-blocks': patch
---

Sandbox: when the index manager recreates the table of a store with indexes, the new table keeps the old table's encryption key, TTL, tags, point-in-time recovery, stream, and table class. A sandbox table with `protection: 'locked'` is no longer deleted, and its indexes change one at a time. A key from `KVStore.fromKmsKey()` must allow the index manager's role in its key policy. A table that an earlier version already recreated keeps the settings it has now.
