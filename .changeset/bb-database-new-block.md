---
"@aws-blocks/bb-database": minor
---

feat(bb-database): add `@aws-blocks/bb-database`, a preview of one `Database` block that runs on a cluster

- `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'distributed'`) with one schema per block. Ordinary PostgreSQL migration files are rewritten into a plan DSQL accepts (`bigint` identity columns with a cache, `ASYNC` indexes, `NOT VALID` constraints validated asynchronously), checked with AWS's `dsql-lint`, and resume at a failed step; app functions wait for a block's migrations, and DSQL jobs are polled for up to two hours.
- `@aws-blocks/blocks` does not depend on or re-export the block yet; import from `@aws-blocks/bb-database`.
- `query()` and `queryOne()` take `{ schema }`, a Standard Schema (Zod, Valibot, ArkType) that types the result from a value and validates every row; a mismatch is `DatabaseErrors.ResultValidationFailed`. The same option is on the `tx` a `transaction()` callback receives.
- An `ApiError` or any branded Blocks error thrown inside `transaction()` reaches the caller unchanged (a 404 stays a 404); only other errors become `TransactionFailed`.
- `bigint` results (identity columns, `count(*)`, `sum()` over integers) are JavaScript numbers on DSQL as they are locally; a value beyond ±2^53 is a `BigInt` in both.
- The test helper `simulateConflict(db)` lives in `@aws-blocks/bb-database/testing`; the block's runtime class exposes only `query`, `queryOne`, `execute`, `transaction`, `cluster` and `schemaName`.
- A `Database` is bound to one cluster for life; the dev server enforces it with a marker in `.bb-data`. The production deploy guard is a separate change.
