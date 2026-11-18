---
"@aws-blocks/bb-database": minor
"@aws-blocks/blocks": minor
---

A `Database` that owns its Aurora DSQL cluster declares the cluster under the CloudFormation logical id that `DistributedDatabase` of `@aws-blocks/bb-distributed-data` used, `<fullId>DsqlCluster`. An app that changes a `DistributedDatabase` to a `Database` with the same id, in the same scope and stack, keeps its cluster and its rows on the next deploy. `Database` reads the `_migrations` table that `DistributedDatabase` wrote, so an applied migration file does not run again. The guide `docs/guides/upgrading-older-apps.md` has the steps.

Two `Database` blocks that each own a cluster, with ids that differ only in characters a logical id cannot have (`db-a` and `dba` in one scope), now fail at synth with an error that names both.
