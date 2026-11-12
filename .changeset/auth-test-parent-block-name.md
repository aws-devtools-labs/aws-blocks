---
'@aws-blocks/bb-agent': patch
'@aws-blocks/bb-distributed-data': patch
---

Internal: the user-agent tests name their parent auth block `Auth` instead of `AuthBasic`, which this release removes. No runtime change.
