---
"@aws-blocks/bb-database": minor
---

feat(bb-database): add `@aws-blocks/bb-database`, a preview of one `Database` block that runs on a cluster

- `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'dsql'`) with one schema per block. Migrations are written in DSQL, as AWS documents it, and run as written: every file is checked with AWS's `dsql-lint` locally and at synth (a PostgreSQL spelling such as `SERIAL` or `CREATE INDEX` without `ASYNC` stops the deploy with the linter's suggestion), each DDL statement runs in its own transaction, and the runner waits for the jobs that `ASYNC` statements start and resumes a failed file at the failed step; app functions wait for a block's migrations, and DSQL jobs are polled for up to two hours.
- `@aws-blocks/blocks` does not depend on or re-export the block yet; import from `@aws-blocks/bb-database`.
- `query()` and `queryOne()` take `{ schema }`, a Standard Schema (Zod, Valibot, ArkType) that types the result from a value and validates every row; a mismatch is `DatabaseErrors.ResultValidationFailed`. The same option is on the `tx` a `transaction()` callback receives.
- An `ApiError` or any branded Blocks error thrown inside `transaction()` reaches the caller unchanged (a 404 stays a 404); only other errors become `TransactionFailed`.
- `bigint` results (identity columns, `count(*)`, `sum()` over integers) are JavaScript numbers on DSQL as they are locally; a value beyond ±2^53 is a `BigInt` in both.
- The test helper `simulateConflict(db)` lives in `@aws-blocks/bb-database/testing`; the block's runtime class exposes only `query`, `queryOne`, `execute`, `transaction`, `cluster` and `schemaName`.
- A `Database` is bound to one cluster for life; the dev server enforces it with a marker in `.bb-data`. The production deploy guard is a separate change.
