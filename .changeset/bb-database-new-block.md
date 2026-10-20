---
"@aws-blocks/bb-database": minor
"@aws-blocks/core": minor
---

feat(bb-database): add `@aws-blocks/bb-database`, a preview of one `Database` block that runs on a cluster

- `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'distributed'`) with one schema per block. Ordinary PostgreSQL migration files are rewritten into a plan DSQL accepts (`bigint` identity columns with a cache, `ASYNC` indexes, `NOT VALID` constraints validated asynchronously), checked with AWS's `dsql-lint`, and resume at a failed step; app functions wait for a block's migrations, and DSQL jobs are polled for up to two hours.
- A `Database` keeps its cluster for life: `bb-database predeploy` stops a production deploy that would move a block or replace a cluster, and lets a deleted block's retained cluster go.
- `@aws-blocks/core`: the `deploy` and `sandbox` scripts run pre-deploy hooks that installed blocks declare in `package.json` under `aws-blocks.predeploy`; `bb-database` declares its deploy guard there. `runPredeployHooks()` and the hook types are exported from `@aws-blocks/core/scripts`.
- `@aws-blocks/blocks` does not depend on or re-export the block yet; import from `@aws-blocks/bb-database`.
