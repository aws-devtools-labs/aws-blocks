---
"@aws-blocks/bb-database": minor
"@aws-blocks/blocks": patch
"@aws-blocks/core": minor
---

feat(bb-database): add `@aws-blocks/bb-database`, a preview of one `Database` block that runs on a cluster

- `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'distributed'`) with one schema per block. Ordinary PostgreSQL migration files are rewritten into a plan DSQL accepts (`bigint` identity columns with a cache, `ASYNC` indexes, `NOT VALID` constraints validated asynchronously) and resume at a failed step; app functions wait for a block's migrations, and DSQL jobs are polled for up to two hours.
- A `Database` keeps its cluster for life: `bb-database predeploy` stops a production deploy that would move a block or replace a cluster, and lets a deleted block's retained cluster go.
- `@aws-blocks/core` deploy script runs `bb-database predeploy` when the package is installed.
- `@aws-blocks/blocks` `getSdkIdentifiers()` learns the new block. The umbrella does not re-export it yet; import from `@aws-blocks/bb-database`.
