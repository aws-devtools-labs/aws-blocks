---
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/blocks": patch
---

`DistributedTable` mock: order GSI sort-key ties deterministically to match DynamoDB.

When a GSI sort key was shared by multiple items, the mock's `query` fell back to Map insertion order for the tied rows — so results depended on write order / disk-reload order and diverged from deployed behavior. The mock now tie-breaks on the base-table primary key (partition key, then sort key), matching how DynamoDB orders index rows with equal sort keys, and reverses the whole order (ties included) under `order: 'desc'`. No change for unique sort keys.
