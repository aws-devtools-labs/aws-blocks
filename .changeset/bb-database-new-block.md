---
"@aws-blocks/bb-database": minor
"@aws-blocks/blocks": minor
"@aws-blocks/core": minor
---

feat(bb-database): one `Database` block for every PostgreSQL cluster kind

A new Building Block, `@aws-blocks/bb-database`: one `Database` block for every
PostgreSQL cluster kind. `bb-data` and `bb-distributed-data` are unchanged.

- **`Database`** runs on a cluster. Omit `cluster` and the block owns an Aurora
  DSQL cluster. Otherwise pass a **`DatabaseCluster`** (part of the block, not
  a block of its own), constructed with a
  `type` that names a category rather than a service — `'distributed'` (Aurora
  DSQL) or `'provisioned'` (Aurora Serverless v2) — or
  `DatabaseCluster.fromExisting()` for a PostgreSQL you already have. Several
  blocks may share one cluster; each gets its own schema (`schemaName`
  defaults to the block id).
- **One runtime API for every kind:** `query`, `queryOne`, `execute`,
  `transaction` (with `retryOnConflict`), the `sql` tag, the Kysely adapter,
  and `simulateConflict()` on the mock. `withRLS()` and `crud()` exist only on
  `Database<'provisioned' | 'external'>` — the capability gap is a compile error
  first, a dev-server error second, and never a production surprise.
- **Portable migrations:** one directory of ordinary PostgreSQL files per block
  (`./aws-blocks/migrations/{id}`). A rewriter turns them into a plan the
  cluster accepts (`SERIAL` → identity with `CACHE 65536`, `CREATE INDEX` →
  `ASYNC` + wait, `ADD CONSTRAINT … CHECK` → `NOT VALID` + validate, one DDL per
  transaction on DSQL) and rejects what a `distributed` cluster cannot run,
  citing the DSQL doc page. `npx bb-database migrate --explain` prints the plan.
  A failed migration resumes at the failed step.
- **The binding rule:** a `Database` keeps its cluster for life. The CDK layer
  records bindings in stack metadata (`aws-blocks:bindings`), the dev server
  keeps a per-block marker under `.bb-data/`, and a deploy guard runs before
  `cdk deploy` in production (record diff plus a change-set scan for removed or
  replaced cluster resources). The sandbox stage skips the guard.
- `Database` and `DatabaseCluster` short ids are unique per app, enforced at
  construction; two blocks on one cluster with the same schema is an error.

`@aws-blocks/blocks` re-exports `DatabaseCluster` and the cluster types. Its
`Database` export is unchanged (still `bb-data`); import the new block's
`Database` from `@aws-blocks/bb-database`.

`@aws-blocks/core`'s deploy and sandbox scripts gain a predeploy step that
invokes `bb-database predeploy` when the project depends on the package (a
no-op otherwise): the deploy guard in production, and host-side migrations for
blocks on `fromExisting()` clusters.
