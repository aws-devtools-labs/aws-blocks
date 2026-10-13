---
"@aws-blocks/bb-database": minor
"@aws-blocks/blocks": minor
"@aws-blocks/core": minor
---

feat(bb-database): add `@aws-blocks/bb-database`, one `Database` block for every PostgreSQL cluster kind

- `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'distributed' | 'provisioned'`) or `DatabaseCluster.fromExisting()`. Each block on a shared cluster gets its own schema.
- `@aws-blocks/blocks` re-exports `DatabaseCluster`; its `Database` export is unchanged.
- `@aws-blocks/core` deploy and sandbox scripts run `bb-database predeploy` when the package is installed.
