---
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

Refresh Aurora DSQL compatibility guidance for current JSONB, persistent views,
sequences and identity columns, and `ALTER TABLE DROP COLUMN` support.
Distinguish DSQL service limitations from SQL that the `DistributedDatabase`
local validator still rejects.
