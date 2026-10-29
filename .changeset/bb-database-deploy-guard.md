---
"@aws-blocks/bb-database": minor
---

feat(bb-database): production deploy guard for cluster bindings

- A `Database` is bound to one cluster, by id and type, at its first deploy, and keeps it for life.
- The dev server writes each block's binding to `.bb-data/{fullId}/binding.json` and refuses to start a block whose code disagrees with it; delete `.bb-data` to reset it.
- The CDK layer records each `Database`'s cluster binding, and each `DatabaseCluster`'s resource id, in stack metadata at synth.
- The block declares a pre-deploy hook under `aws-blocks.predeploy` in its `package.json`. A core whose `deploy` script runs pre-deploy hooks calls it before `cdk deploy` in production; an older core ignores the declaration.
- The hook compares the new binding record with the deployed template and stops a deploy that moves a block to another cluster. It then builds a change set and stops if the deploy would remove or replace a DSQL or Aurora cluster that still has a block on it. Deleting a block whose cluster is retained is allowed.
