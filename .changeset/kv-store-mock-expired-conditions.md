---
'@aws-blocks/bb-kv-store': patch
---

The local `KVStore` now treats an expired item the way DynamoDB does. `get` and `scan` still hide it, but `put({ ifNotExists })`, `delete({ ifExists })`, `ifValueEquals` and `scan({ includeExpired: true })` keep seeing it until it is removed. Before, a `get` on an expired key deleted it, so a following conditional write could succeed locally and fail with a conflict on AWS.

Expired items are now removed from the local store when it loads its data file, which stands in for DynamoDB's background TTL deletion.
