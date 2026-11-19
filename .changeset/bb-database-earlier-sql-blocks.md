---
"@aws-blocks/bb-database": minor
"@aws-blocks/blocks": minor
---

An app that deployed a SQL block of an earlier release keeps its database.

**`DistributedDatabase`.** A `Database` that owns its Aurora DSQL cluster declares the cluster under the CloudFormation logical id that `DistributedDatabase` of `@aws-blocks/bb-distributed-data` used, `<fullId>DsqlCluster`. An app that changes a `DistributedDatabase` to a `Database` with the same id, in the same scope and stack, keeps its cluster and its rows on the next deploy. `Database` reads the `_migrations` table that `DistributedDatabase` wrote, so an applied migration file does not run again. The guide `docs/guides/upgrading-older-apps.md` has the steps.

Two `Database` blocks that each own a cluster, with ids that differ only in characters a logical id cannot have (`db-a` and `dba` in one scope), now fail at synth with an error that names both.

**`Database` of `@aws-blocks/bb-data`.** `LegacyDatabaseCluster` keeps the Aurora cluster of `Database` in `@aws-blocks/bb-data` 0.5.0 in the stack, with its secret and its VPC, under the same CloudFormation logical ids. An app that deployed that block gives the `LegacyDatabaseCluster` the id and the options of its old `Database`, and passes it as the `cluster` of a `Database` with a new id. The deploy changes nothing in the cluster, and the new `Database` uses its tables and its `_migrations` table. Row Level Security policies apply through `asRole()`; `asUser()` is an error on this cluster. The class is deprecated and frozen. The README section "Upgrade from `@aws-blocks/bb-data`" has the steps.

**An Aurora cluster through the RDS Data API.** `DatabaseCluster.fromExisting({ dataApi: { clusterArn, secretArn, database } })` puts a `Database` on an Aurora PostgreSQL cluster that the block reaches through the RDS Data API. The block opens no connection, so the cluster can stay in a VPC, and the credentials stay in the Secrets Manager secret. The execution role and the migration Lambdas get the Data API actions on that cluster and the read of that secret. The block's schema is `public`, each statement is one HTTPS call, the Data API ends a statement after 45 seconds, and a result is limited to 1 MB. The README section "An Aurora cluster through the Data API" lists the differences from a connection string.
