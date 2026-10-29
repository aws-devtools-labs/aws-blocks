# Database: design

Status: implemented, preview (`dsql` clusters). Usage is documented in [README.md](./README.md).

## Abstract

`@aws-blocks/bb-database` models a SQL database as a schema on a cluster. A `Database` either owns an Aurora DSQL cluster or attaches to a shared `DatabaseCluster` of type `dsql` (Aurora DSQL). The query interface is the same in both cases. Migration files are written in DSQL, as AWS documents it; the block checks them with `dsql-lint`, sequences them into a plan that runs one DDL statement per transaction and waits for the jobs that asynchronous statements start, and resumes a failed file at the failed step. The principal trade-off is that a block is bound to its cluster for its lifetime: changing clusters requires a new block and a data copy, and a deploy-time check enforces this without a production override. A second cluster type, `provisioned` (Aurora Serverless v2, all of PostgreSQL), is designed and not yet shipped; this document notes where the code keeps room for it.

## 1. Introduction

### 1.1 Motivation

AWS Blocks previously offered SQL through two packages, `bb-data` (Aurora) and `bb-distributed-data` (DSQL). Each had its own class, options, migration runner and error set, so moving an application between them required rewriting every call site. Each block also provisioned its own cluster. This package replaces both with a single block whose cluster is a constructor option. The two earlier packages are unchanged.

### 1.2 Requirements

- **R1. Portability.** Application code (queries, transactions, error handling) is unchanged when the cluster changes.
- **R2. Early failure.** An operation the cluster cannot support fails at compile time where the type system can express it, and otherwise on the dev server before any deploy.
- **R3. Sharing.** Several blocks can share one cluster, each in its own schema, without name collisions.
- **R4. Data safety.** No deploy can silently move a block to a different cluster or destroy a cluster that still holds data.

### 1.3 Out of scope

- **In-place cluster migration.** Moving data between clusters is a copy whose timing depends on the application. The README documents the procedure; the package does not automate it.
- **Emulation of DSQL limits.** A `dsql` cluster keeps optimistic concurrency and its per-transaction limits. The package reports these early rather than hiding them.
- **Replacement of `bb-data` and `bb-distributed-data`.** Both remain supported, and the umbrella package's `Database` export still refers to `bb-data`.

## 2. Data model

### 2.1 Clusters and blocks

A `DatabaseCluster` exists only as the value of a `Database`'s `cluster` option. A cluster with no block attached serves no request, so it is not itself a Building Block. It has no `bbName`, no catalog entry, and no telemetry. Its CDK class extends `BuildingBlockScope` only to declare VPC requirements and to reach the stack's execution role. The `type` value names a category of cluster rather than a product, following the convention established by compute. `type` is required even with one category, so the planned second category adds a value without changing any call site.

### 2.2 Schema allocation

A block that owns its cluster uses the `public` schema. A block on a shared cluster uses its id as the schema name unless `schemaName` overrides it. Two blocks on one cluster may not share a schema; the conflict is reported when the second block is constructed. Short ids of `Database` and `DatabaseCluster` are likewise unique per application.

## 3. Type system

`Database` and `DatabaseCluster` are not generic. `ClusterType` has one member, and `type: 'dsql'` is required on `DatabaseCluster` so that a second cluster type, which a later pull request adds, is an additive union change rather than a new call shape. Every entry point resolves the `cluster` option into a plain descriptor, `db.cluster = { kind, id }`, through one shared function in `cluster-ref.ts`. The two `Database` constructor overloads (owned, shared) exist so that an option that belongs to the other shape, such as `removalPolicy` next to `cluster`, is a compile error; `types.test.ts` asserts the option rules with `@ts-expect-error`.

A query's row type can come from a value instead of a type argument: `query()` and `queryOne()`, on the block and on a transaction, accept `{ schema }`, a [Standard Schema](https://standardschema.dev) whose output type becomes the result type and which every row is validated against (`result-schema.ts`). The block depends only on the specification's types, so the schema library is the application's choice. A row that fails raises `ResultValidationFailed`, naming the row and the first issue's path; the row's values stay on the server. This is the first step of the typed-tables track and leaves the type argument form in place.

## 4. Execution environments

### 4.1 Local execution

Locally, each cluster is one PGlite instance on disk, whether a block owns it or several share it. The dev server therefore has the same layout as AWS: one database, one schema per block.

PGlite provides a single session, which imposes two constraints. First, work is serialized by a mutex held for each auto-commit statement or for an entire `BEGIN … COMMIT`, so one block's `SET search_path` cannot occur inside another block's transaction. Second, a query issued from within a block's own `transaction()` callback joins the open transaction instead of waiting on the mutex. The open transaction is tracked with `AsyncLocalStorage`.

Each local engine is wrapped by `MockEngine`, which implements `simulateConflict()` and applies the DSQL checks: `dsql-lint` on each distinct statement (§5.1), the DML-only guard that matches the deployed app role, and the per-transaction limits. It also runs the two asynchronous DDL forms synchronously by stripping the `ASYNC` keyword, and the cluster installs a stub of DSQL's `sys` schema at init (`sys.wait_for_job()` returns `true`, `sys.jobs` is empty) so a job wait written into a migration the way the AWS examples show runs as a no-op (§9). The limits are enforced for explicit transactions and for auto-commit DML statements alike, before the change is committed, so a statement that would exceed them rolls back as on DSQL. Rows removed by an `ON DELETE CASCADE` foreign key are counted by comparing the child tables' row counts before and after the statement; `SET NULL` and `SET DEFAULT` fan-out is not counted. The 10 MiB limit is approximated from the statement text and its parameters.

### 4.2 Schema scoping on AWS

The DSQL engine is a `pg` pool authenticated with IAM tokens. It sets `search_path` once on each new connection. A block that owns its cluster, or sets `schemaName: 'public'`, needs no `search_path`.

## 5. Schema migration

### 5.1 The compatibility checker

Statement compatibility is decided by AWS's [`dsql-lint`](https://github.com/awslabs/aurora-dsql-tools/tree/main/dsql-lint) (`dsql-lint.ts`), the linter the Aurora DSQL team maintains. It parses the SQL, so a keyword inside a literal is never a false positive, and its rules follow DSQL releases, which a hand-written table did not: the 2025 table in `bb-distributed-data` rejected six features DSQL had since added. `@aws/dsql-lint` installs a native binary per platform as optional dependencies, the pattern esbuild uses. The block runs it on each migration file as written, at synth and in the dev server, and on every distinct statement a handler issues locally, with results cached per text (about 8 ms per uncached statement). It is never run on AWS: the migration Lambda builds its plan with `validate: false`, because the files were validated at synth and the binary is not deployed; the app runtime does no validation.

dsql-lint marks some findings as fixable (`fix_result.status` of `fixed` or `fixed_with_warning`: `serial_type`, `index_async`, `foreign_key_not_valid`, `check_not_valid`, `sequence_cache_missing`, `alter_add_unique_collapse`). The block treats them exactly like the unfixable ones: the file stops with the linter's message and suggestion, and the author makes the change (§5.2).

One check stays in the block because it covers a gap in the linter: `GRANT … ON SCHEMA public`, which dsql-lint 0.2.20 accepts but DSQL rejects at runtime (`public` is a system schema). The sandbox run found it when every block that owned its cluster failed to deploy on that grant. `validation.test.ts` pins the rule ids the integration must report and the SQL it must accept, so a `dsql-lint` upgrade that changes a rule shows up there. The baseline is `@aws/dsql-lint` 0.2.20 and the DSQL user guide as of 2026-10-11.

### 5.2 Plan construction

Each block has one directory of migration files written in DSQL, as AWS documents it, and the block runs what the file says. The engine is a framework default rather than the application's choice, so the block carries the engine's differences in its runner and its checks; it does not change the SQL text a customer wrote, because a file that reads one way in the repository and runs another way on the cluster cannot be reviewed. `buildMigrationPlan` therefore only sequences. It splits each file into statements with the shared lexer (string literals, dollar-quoted bodies and comments are respected), gives every DDL statement its own transaction while consecutive DML statements share one (DSQL allows one DDL statement per transaction and no DDL with DML), and follows the two asynchronous forms a file contains, `CREATE [UNIQUE] INDEX ASYNC` and `ALTER TABLE ASYNC … VALIDATE CONSTRAINT`, with a wait for the job DSQL returns. Nothing else is touched or generated; the SQL of every step is the file's statement.

The first cut of this package rewrote PostgreSQL files into those forms at deploy time: `SERIAL` to an identity column with a cache, `CREATE INDEX` to `ASYNC` plus a wait, a named `ADD CONSTRAINT` to `NOT VALID` plus a synthesized validation. It was removed. The rewrite chose values the author had not written (a cache of 65536), left an unnamed constraint `NOT VALID` with no validation, tracked DSQL's grammar in regular expressions, and made the SQL that ran on the cluster differ from the file in the repository, visible only through a CLI that printed the plan. With the rewrite gone, dsql-lint's findings for those spellings stop the file like any other, with the linter's own suggestion (§5.1). An author with an existing PostgreSQL file can run `dsql-lint --fix` once and review the result; the block does not do it silently.

### 5.3 Resumable execution

The runner records progress after each step in a `_migration_progress` table in the block's schema. A file that fails at step 4 of 6 resumes at step 4 on the next run. Replaying earlier steps would re-execute DDL that already succeeded, which DSQL does not run transactionally and so cannot roll back. Completed files are recorded in `_migrations`. A wait step records the DSQL job it is waiting on, so a later run can check `sys.jobs` instead of re-issuing the DDL; a job missing from `sys.jobs` is treated as completed, because DSQL purges finished jobs after 30 minutes. Locally the wait step is a no-op: PGlite runs the asynchronous forms synchronously and returns no job id, so there is nothing to poll.

### 5.4 Deployment

Each cluster has two migration Lambdas built from one bundle and one custom-resource provider; each block has one CloudFormation custom resource. Resources on the same cluster depend on one another, so blocks migrate sequentially. CDK bundles a function's code when the function is constructed, which precedes the attachment of any block. Migration files therefore cannot be bundled with the Lambda. Instead, each block publishes its files as a single JSON asset in S3, and its custom resource carries the asset's location. A change to the files changes the asset hash, which causes CloudFormation to re-run the resource.

The provider's `onEvent` handler runs the plan until it finishes or reaches a DSQL job that is still running, and the `isComplete` handler resumes it on every poll, every 30 seconds for up to two hours. A long index build is therefore bounded by the provider's total timeout, not by one invocation's ten minutes. When the plan is complete the handler creates the per-cluster app role if needed, maps it to the stack's execution role with `AWS IAM GRANT`, and grants it DML on the schema's tables, `SELECT` on its views and `USAGE` on its sequences.

Every Lambda function that assumes the stack's execution role is made to depend on each block's custom resource, through a CDK aspect that runs at synth after all constructs exist. A deploy therefore applies a block's migrations before any new handler code runs.

## 6. Cluster binding

A block is bound to its cluster by id and type (R4). The dev server writes the binding to `.bb-data/{fullId}/binding.json` and refuses to start a block whose code disagrees with it; deleting `.bb-data` resets it. Deploy-time verification, a binding record in stack metadata and a pre-deploy guard that inspects a change set before `cdk deploy`, is a separate pull request; until it lands, production relies on the cluster's removal policy.

## 7. Alternatives considered

**Separate blocks per service.** This keeps each block small and introduces no new concepts. It violates R1, because changing service requires rewriting call sites, and R3, because no mechanism shares a cluster.

**Static factory methods** (`Database.dsql()`, `Database.aurora()`). This retains a single class with concise call sites. It exposes service names in the public interface and provides no value that several blocks could share, so R3 would need a second mechanism.

**A hand-written compatibility rule table.** The first cut of this package kept `bb-distributed-data`'s regex rules, re-baselined by hand against the DSQL docs. Comparing that table with `dsql-lint` on the same examples found two errors in the table within minutes (array types and `USING btree` are unsupported) and no case the linter missed. A regex table also cannot parse, so it guesses at literals and comments. #446 had already shown `dsql-lint` working in `bb-distributed-data`'s mock and at synth; this package follows it.

**Rewriting PostgreSQL migrations into DSQL at deploy time.** The first cut did this, so that an application written for PostgreSQL could keep its files. §5.2 records why it was removed: the SQL that ran was not the SQL in the repository.

**Waiting on DDL jobs inside one Lambda invocation.** Simpler than two handlers, but a Lambda runs for at most 15 minutes, and an index build on a large table can take longer. The provider's `isComplete` polling has a two-hour budget.

**An override for the binding check.** An environment variable would permit deliberate cluster moves. It weakens R4, since an override set once in a CI configuration persists unnoticed. The sandbox exemption and the documented copy procedure cover the legitimate cases.

## 8. Security and cost

**Security.** The application connects as a per-cluster database role. The migration Lambdas create this role and map it to the stack's execution role with `AWS IAM GRANT`. The role holds DML privileges on the block's tables only; DDL requires the admin token, which only the migration Lambdas hold. The stack's execution role is granted `dsql:DbConnect` on the cluster; the migration Lambdas are granted `dsql:DbConnectAdmin`.

**Cost.** A DSQL cluster incurs no cost when idle. Each cluster adds two migration Lambdas and one custom-resource provider, which run only during deploys. A `Database` that owns its cluster is one DSQL cluster against the default quota of 20 per account and Region; blocks sharing a `DatabaseCluster` count once.

**Observability.** Driver errors retain their SQLSTATE on the server-side `cause`. Only the `DatabaseErrors` name and a fixed message are sent to the client. The migration Lambdas log each applied file, each job they wait on, and, on failure, the step at which they stopped.

## 9. Behavioral differences between environments

| Area | Local | AWS |
|---|---|---|
| Concurrency | Serialized per cluster (one PGlite session) | Concurrent; DSQL may raise `40001` at commit |
| DSQL feature gaps | Rejected by `dsql-lint` before PGlite | Rejected by DSQL (`42501`, reported as `QueryFailed`) |
| `ASYNC` DDL (`CREATE INDEX ASYNC`, `ALTER TABLE ASYNC … VALIDATE CONSTRAINT`) | Runs synchronously: the mock strips `ASYNC`; the job wait is a no-op. `sys.wait_for_job()` returns `true` at once and `sys.jobs` is empty, so a wait written into a file runs unchanged | DSQL returns a job id; the runner polls `sys.jobs` every 30 seconds for up to two hours |
| 3,000-row and 10 MiB transaction limits | Enforced by the mock, cascades counted; size approximated | Enforced by DSQL (`54000`); both reported as `TransactionRowLimitExceeded` |
| `simulateConflict()` (`@aws-blocks/bb-database/testing`) | Available | Throws |
| `bigint` results (identity columns, `count(*)`, `sum()` over integers) | PGlite: a `number`, or a `BigInt` beyond ±2^53 | pg would return a string; `dsql-engine.ts` installs a parser that matches PGlite |
| An `ApiError` or branded Blocks error thrown inside `transaction()` | Passes through unchanged after the rollback | Same |

## 10. Limitations and future work

**Known limitations.**

1. `dsql-lint` checks syntax, not the catalog: a statement that is valid SQL but wrong for the schema (a cascade past 3,000 rows, a duplicate key during an index build) fails on DSQL, not locally.
2. The mock counts `ON DELETE CASCADE` fan-out toward the row limit but not `SET NULL` or `SET DEFAULT`, and approximates the 10 MiB limit from statement and parameter sizes.
3. A `CREATE INDEX` or constraint validation that DSQL fails leaves the index `INVALID` or the constraint `NOT VALID`; the deploy fails with the job's details, and the fix is to repair the data and deploy again.

**Future work.** Each item states the condition for revisiting it.

1. **`type: 'provisioned'`** (Aurora Serverless v2), `DatabaseCluster.fromExisting()`, `withRLS()` and `crud()`: the second pull request of the design.
2. **Safe replacement**, a `replaces` option naming a previous binding. The same need exists for `KVStore`, `FileBucket` and `DistributedTable`, so it warrants one design across data blocks.
3. **Compile-time binding verification** from a lock file written by deploys. The per-application uniqueness of short ids (§2.2) allows a block to be identified by the literal in its constructor. Revisit once deploys can write files back to the repository.
4. **A copy command.** The README procedure suffices until copies are a recurring request.
5. **Multi-region DSQL** (`regions`, `witnessRegion`). Revisit when the feature is scheduled.

## Appendix A. Source map

| Concern | Files |
|---|---|
| Public types and option shapes | `src/types.ts`; constructor overloads in `src/index.mock.ts` |
| Resolution of the `cluster` option | `src/cluster-ref.ts` (shared by all entry points) |
| Queries, transactions and retries | `src/database-core.ts`, `src/transaction.ts` |
| Result schema validation | `src/result-schema.ts` |
| Test helpers and the internal access channel | `src/testing.ts`, `src/internal.ts` |
| DSQL connection and result type parsers | `src/engines/dsql-engine.ts` |
| Local engine, schema switching and the `sys` stub | `src/engines/pglite-cluster.ts`, `src/engines/mock-engine.ts` |
| DSQL compatibility checks and plan sequencing | `src/dsql-lint.ts`, `src/validation.ts`, `src/migrations/plan.ts` |
| Resumable runner and job waits | `src/migrations/runner.ts` |
| Provisioning and the migration Lambdas | `src/infra/cluster-infra.ts`, `src/migration-lambda.ts` |
| Binding rule (dev-server marker) | `src/bindings.ts` |
