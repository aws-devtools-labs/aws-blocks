---
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/blocks": patch
---

Isolate DistributedTable's local stored data from write inputs and read results so unsaved object mutations cannot change records or be persisted by unrelated writes.
