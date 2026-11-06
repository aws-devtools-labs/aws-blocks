# @aws-blocks/bb-database

## 0.2.0

### Minor Changes

- 4e41c28: feat(bb-database): add `@aws-blocks/bb-database`, a preview of one `Database` block that runs on a cluster

  - `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'dsql'`) with one schema per block. Migrations are written in DSQL, as AWS documents it, and run as written: every file is checked with AWS's `dsql-lint` locally and at synth (a PostgreSQL spelling such as `SERIAL` or `CREATE INDEX` without `ASYNC` stops the deploy with the linter's suggestion), each DDL statement runs in its own transaction, and the runner waits for the jobs that `ASYNC` statements start, resumes a failed file at the failed step (a failed `ASYNC` job rewinds to its statement and drops the `INVALID` index it left, and a job purged from `sys.jobs` is verified in the catalog), and refuses a file that was edited after a partial run (restore the text to finish it, and put the change in a new file); app functions wait for a block's migrations, and DSQL jobs are polled for up to 55 minutes, inside the one hour CloudFormation waits for a custom resource.
  - `@aws-blocks/blocks` does not depend on or re-export the block yet; import from `@aws-blocks/bb-database`.
  - `query()` and `queryOne()` take `{ schema }`, a Standard Schema (Zod, Valibot, ArkType) that types the result from a value and validates every row; a mismatch is `DatabaseErrors.ResultValidationFailed`, whose message names the row index and the field while the library's issue text stays on the server. The same option is on the `tx` a `transaction()` callback receives.
  - An `ApiError` or any branded Blocks error thrown inside `transaction()` reaches the caller unchanged (a 404 stays a 404); only other errors become `TransactionFailed`.
  - `db.query()`, `db.queryOne()` and `db.execute()` called inside the block's own `transaction()` callback run in that transaction, locally and on DSQL.
  - Locally, a call to another block on the same cluster from inside a `transaction()` callback runs inside that transaction as a savepoint instead of waiting on the single PGlite session; on DSQL it runs on its own connection. The README's Local mode section describes the difference.
  - `bigint` results (identity columns, `count(*)`, `sum()` over integers) are JavaScript numbers on DSQL as they are locally; a value beyond ±2^53 is a `BigInt` in both.
  - The test helper `simulateConflict(db)` lives in `@aws-blocks/bb-database/testing`; the block's runtime class exposes only `query`, `queryOne`, `execute`, `transaction`, `cluster` and `schemaName`.
  - A renamed `Database` or `DatabaseCluster` id keeps the old cluster and its data under the default `retain` removal policy, but points the app at a new, empty one. The deploy guard that stops such a move is a separate change.

### Patch Changes

- Updated dependencies [b2eb306]
- Updated dependencies [a5e754b]
- Updated dependencies [f133ff8]
- Updated dependencies [9ebf67a]
- Updated dependencies [3ae8592]
- Updated dependencies [3ae8592]
- Updated dependencies [9059918]
- Updated dependencies [c1fabce]
- Updated dependencies [b2eb306]
- Updated dependencies [0cf1aa2]
- Updated dependencies [c1fabce]
- Updated dependencies [d7f62f3]
- Updated dependencies [3be61fa]
- Updated dependencies [36888a1]
- Updated dependencies [fcf087d]
- Updated dependencies [2c9005f]
- Updated dependencies [6151940]
- Updated dependencies [b7c262c]
- Updated dependencies [c1fabce]
- Updated dependencies [1ec956f]
- Updated dependencies [c1fabce]
- Updated dependencies [ba80bbd]
- Updated dependencies [05a88e1]
- Updated dependencies [ee557d4]
- Updated dependencies [b2eb306]
- Updated dependencies [201e59e]
- Updated dependencies [60360c1]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [80ce128]
- Updated dependencies [58980c7]
  - @aws-blocks/core@0.9.0
  - @aws-blocks/data-common@0.1.8
  - @aws-blocks/bb-logger@0.4.0
