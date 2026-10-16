---
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/data-common": patch
"@aws-blocks/blocks": patch
---

Validate SQL with the latest `dsql-lint` release

`DistributedDatabase` depends on `@aws/dsql-lint` `>=0.2.22`, so local and
synth-time validation uses the newest `dsql-lint` release. The local mock runs
Aurora DSQL's asynchronous DDL, including `CREATE INDEX ASYNC` and
`ALTER TABLE ASYNC`, and the SQL Building Block docs describe Aurora DSQL's
PostgreSQL compatibility, including foreign keys.
