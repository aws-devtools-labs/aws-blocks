---
"@aws-blocks/bb-distributed-table": minor
"@aws-blocks/blocks": patch
---

perf(bb-distributed-table): declare GSIs natively so a fresh deploy provisions them all at once

A `DistributedTable` with global secondary indexes previously created the table
with no indexes and then had a CloudFormation custom resource add each GSI one at
a time via `UpdateTable` (DynamoDB allows only one GSI change in flight on a live
table). On a fresh deploy this serialized tail dominated wall-clock — 8–25 minutes
on the todo templates, independent of item count, since an empty new table has
nothing to backfill.

The configured indexes are now declared **natively** on the CDK `Table`
(`globalSecondaryIndexes`), so a fresh `CreateTable` provisions every index in a
single shot — DynamoDB permits any number of GSIs at table-creation time; the
one-in-flight limit only applies to adding a GSI to an existing table. Projection
is `ALL`, matching what the reconciler creates.

The `gsi-resource` custom resource is **retained** for GSI mutations on an
already-existing table (a later redeploy that adds or removes an index), where
one-at-a-time is unavoidable. Because its Lambda is a diff reconciler, on a fresh
table whose indexes were just created natively it sees them already present and
no-ops. `fromExisting` behavior (the customer owns the index lifecycle) is
unchanged.
