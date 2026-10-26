# Database: design

Status: implemented, preview (`distributed` clusters). Usage is documented in [README.md](./README.md).

## Abstract

`@aws-blocks/bb-database` models a SQL database as a schema on a cluster. A `Database` either owns an Aurora DSQL cluster or attaches to a shared `DatabaseCluster` of type `distributed` (Aurora DSQL). The query interface is the same in both cases. One set of ordinary PostgreSQL migration files serves the cluster through a rewriting step that produces a plan DSQL accepts and that resumes at a failed step. The principal trade-off is that a block is bound to its cluster for its lifetime: changing clusters requires a new block and a data copy, and a deploy-time check enforces this without a production override. A second cluster type, `provisioned` (Aurora Serverless v2, all of PostgreSQL), is designed and not yet shipped; this document notes where the code keeps room for it.

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
- **Emulation of DSQL limits.** A `distributed` cluster keeps optimistic concurrency and its per-transaction limits. The package reports these early rather than hiding them.
- **Replacement of `bb-data` and `bb-distributed-data`.** Both remain supported, and the umbrella package's `Database` export still refers to `bb-data`.

## 2. Data model

### 2.1 Clusters and blocks

A `DatabaseCluster` exists only as the value of a `Database`'s `cluster` option. A cluster with no block attached serves no request, so it is not itself a Building Block. It has no `bbName`, no catalog entry, and no telemetry. Its CDK class extends `BuildingBlockScope` only to declare VPC requirements and to reach the stack's execution role. The `type` value names a category of cluster rather than a product, following the convention established by compute. `type` is required even with one category, so the planned second category adds a value without changing any call site.

### 2.2 Schema allocation

A block that owns its cluster uses the `public` schema. A block on a shared cluster uses its id as the schema name unless `schemaName` overrides it. Two blocks on one cluster may not share a schema; the conflict is reported when the second block is constructed. Short ids of `Database` and `DatabaseCluster` are likewise unique per application.

## 3. Type system

`Database` and `DatabaseCluster` are not generic. `ClusterType` has one member, and `type: 'distributed'` is required on `DatabaseCluster` so that a second cluster type, which a later pull request adds, is an additive union change rather than a new call shape. Every entry point resolves the `cluster` option into a plain descriptor, `db.cluster = { kind, id }`, through one shared function in `cluster-ref.ts`. The two `Database` constructor overloads (owned, shared) exist so that an option that belongs to the other shape, such as `removalPolicy` next to `cluster`, is a compile error; `types.test.ts` asserts the option rules with `@ts-expect-error`.

A query's row type can come from a value instead of a type argument: `query()` and `queryOne()`, on the block and on a transaction, accept `{ schema }`, a [Standard Schema](https://standardschema.dev) whose output type becomes the result type and which every row is validated against (`result-schema.ts`). The block depends only on the specification's types, so the schema library is the application's choice. A row that fails raises `ResultValidationFailed`, naming the row and the first issue's path; the row's values stay on the server. This is the first step of the typed-tables track and leaves the type argument form in place.

## 4. Execution environments

### 4.1 Local execution

Locally, each cluster is one PGlite instance on disk, whether a block owns it or several share it. The dev server therefore has the same layout as AWS: one database, one schema per block.

PGlite provides a single session, which imposes two constraints. First, work is serialized by a mutex held for each auto-commit statement or for an entire `BEGIN … COMMIT`, so one block's `SET search_path` cannot occur inside another block's transaction. Second, a query issued from within a block's own `transaction()` callback joins the open transaction instead of waiting on the mutex. The open transaction is tracked with `AsyncLocalStorage`.

Each local engine is wrapped by `MockEngine`, which implements `simulateConflict()` and applies the DSQL checks: `dsql-lint` on each distinct statement (§5.1), the DML-only guard that matches the deployed app role, and the per-transaction limits. The limits are enforced for explicit transactions and for auto-commit DML statements alike, before the change is committed, so a statement that would exceed them rolls back as on DSQL. Rows removed by an `ON DELETE CASCADE` foreign key are counted by comparing the child tables' row counts before and after the statement; `SET NULL` and `SET DEFAULT` fan-out is not counted. The 10 MiB limit is approximated from the statement text and its parameters.

### 4.2 Schema scoping on AWS

The DSQL engine is a `pg` pool authenticated with IAM tokens. It sets `search_path` once on each new connection. A block that owns its cluster, or sets `schemaName: 'public'`, needs no `search_path`.

## 5. Schema migration

### 5.1 The compatibility checker

Statement compatibility is decided by AWS's [`dsql-lint`](https://github.com/awslabs/aurora-dsql-tools/tree/main/dsql-lint) (`dsql-lint.ts`), the linter the Aurora DSQL team maintains. It parses the SQL, so a keyword inside a literal is never a false positive, and its rules follow DSQL releases, which a hand-written table did not: the 2025 table in `bb-distributed-data` rejected six features DSQL had since added. `@aws/dsql-lint` installs a native binary per platform as optional dependencies, the pattern esbuild uses. The block runs it on the rewritten SQL of each migration file at synth and in the dev server, and on every distinct statement a handler issues locally, with results cached per text (about 8 ms per uncached statement). It is never run on AWS: the migration Lambda builds its plan with `validate: false`, because the files were validated at synth and the binary is not deployed; the app runtime does no validation.

Three checks stay in the block because they need more than one statement, exist for the rewriter's sake, or cover a gap in the linter: dropping a primary-key column, detected from the `CREATE TABLE` seen earlier in the same plan; an unnamed `ADD CHECK` / `ADD FOREIGN KEY`, which the rewriter could not validate by name; and `GRANT … ON SCHEMA public`, which dsql-lint 0.2.20 accepts but DSQL rejects at runtime (`public` is a system schema). The sandbox run found the third when every block that owned its cluster failed to deploy on that grant. `validation.test.ts` pins the rule ids the integration must report and the SQL it must accept, so a `dsql-lint` upgrade that changes a rule shows up there. The baseline is `@aws/dsql-lint` 0.2.20 and the DSQL user guide as of 2026-10-11.

### 5.2 Plan construction

Each block has one directory of ordinary PostgreSQL migration files. `buildMigrationPlan` converts them into an ordered list of steps for a `distributed` cluster, applying these rewrites:

- `SERIAL`, `BIGSERIAL` and `SMALLSERIAL`, and identity columns on `smallint` or `integer`, become `BIGINT GENERATED … AS IDENTITY (CACHE 65536)`; an identity column or `CREATE SEQUENCE` without a cache gets `CACHE 65536`, and a sequence typed smaller than `bigint` becomes `bigint`;
- `CREATE INDEX` becomes `CREATE INDEX ASYNC` followed by a wait on the index job;
- `ALTER TABLE … ADD CONSTRAINT … CHECK` and `… FOREIGN KEY` gain `NOT VALID`, followed by `ALTER TABLE ASYNC … VALIDATE CONSTRAINT` and a wait on the validation job. A `REFERENCES` inside `CREATE TABLE` is left as written; the table is empty.

Each DDL statement also runs in its own transaction. The rewritten statements are then checked with `dsql-lint` (§5.1), which rejects exactly the forms the rewriter produces when they are missing (`serial_type`, `index_async`, `check_not_valid`, `foreign_key_not_valid`, `identity_cache_missing`), so the two compose: the rewriter fixes what has a mechanical fix, the linter reports what is left, naming the file and the rule. The rewriter never touches string literals, dollar-quoted bodies, or comments. `CACHE 65536` is the author's choice over the `CACHE 1` that `dsql-lint --fix` writes; `CACHE 1` gives strict ordering at the cost of a coordination round per value, and a user who needs it writes it.

Still to do, and safe to leave as rejections meanwhile: `ADD COLUMN … DEFAULT` as add, set default and backfill; `TRUNCATE` as batched deletes; index `ASC` / `DESC` removed; DML split at 3,000 rows.

### 5.3 Resumable execution

The runner records progress after each step in a `_migration_progress` table in the block's schema. A file that fails at step 4 of 6 resumes at step 4 on the next run. Replaying earlier steps would re-execute DDL that already succeeded, which DSQL does not run transactionally and so cannot roll back. Completed files are recorded in `_migrations`. A wait step records the DSQL job it is waiting on, so a later run can check `sys.jobs` instead of re-issuing the DDL; a job missing from `sys.jobs` is treated as completed, because DSQL purges finished jobs after 30 minutes.

### 5.4 Deployment

Each cluster has two migration Lambdas built from one bundle and one custom-resource provider; each block has one CloudFormation custom resource. Resources on the same cluster depend on one another, so blocks migrate sequentially. CDK bundles a function's code when the function is constructed, which precedes the attachment of any block. Migration files therefore cannot be bundled with the Lambda. Instead, each block publishes its files as a single JSON asset in S3, and its custom resource carries the asset's location. A change to the files changes the asset hash, which causes CloudFormation to re-run the resource.

The provider's `onEvent` handler runs the plan until it finishes or reaches a DSQL job that is still running, and the `isComplete` handler resumes it on every poll, every 30 seconds for up to two hours. A long index build is therefore bounded by the provider's total timeout, not by one invocation's ten minutes. When the plan is complete the handler creates the per-cluster app role if needed, maps it to the stack's execution role with `AWS IAM GRANT`, and grants it DML on the schema's tables, `SELECT` on its views and `USAGE` on its sequences.

Every Lambda function that assumes the stack's execution role is made to depend on each block's custom resource, through a CDK aspect that runs at synth after all constructs exist. A deploy therefore applies a block's migrations before any new handler code runs.

## 6. Cluster binding

### 6.1 Binding record

At its first deploy, a block is bound to its cluster by id and type. The CDK layer writes this record to stack metadata under `aws-blocks:bindings`, together with the CloudFormation logical id of each cluster resource, keyed by the `Database` that owns it or the `DatabaseCluster` it belongs to. The dev server writes the same record, without the logical id, to `.bb-data/{fullId}/binding.json` and refuses to start a block whose code disagrees with it. Deleting `.bb-data` resets the local record.

### 6.2 Deploy-time verification

Before `cdk deploy` in the production stage, the block's pre-deploy hook (`src/predeploy.ts`) applies two checks to each synthesized stack (R4). The package declares the hook in `package.json` under `aws-blocks.predeploy` with `stages: ['production']`; core's deploy script discovers hooks from the app's installed `@aws-blocks/*` packages, synthesizes once, and runs them. Core therefore carries no code that names this block. `npx bb-database predeploy` is a dry run of the same hooks through core's runner.

1. The new binding record is compared with the deployed template. This detects a block moving between two clusters that both retain other blocks, a change CloudFormation does not consider destructive.
2. A change set is created, inspected and deleted. Any `Replace` of an Aurora or DSQL cluster stops the deploy. A `Remove` stops it unless the resource belongs to a block or `DatabaseCluster` that is absent from the new record and the deployed resource's `DeletionPolicy` is `Retain`: that is deleting a block, which keeps its data. A `Remove` of a cluster whose owner is still in the record is a renamed construct, and stops.

A template larger than CloudFormation's 51,200-byte inline limit is staged in the CDK bootstrap assets bucket and passed by URL, then deleted. The stop message names the resource and states whether its removal policy retains or deletes the data. Sandbox stages are exempt from both checks because their clusters are destroyed with the stack.

## 7. Alternatives considered

**Separate blocks per service.** This keeps each block small and introduces no new concepts. It violates R1, because changing service requires rewriting call sites, and R3, because no mechanism shares a cluster.

**Static factory methods** (`Database.dsql()`, `Database.aurora()`). This retains a single class with concise call sites. It exposes service names in the public interface and provides no value that several blocks could share, so R3 would need a second mechanism.

**A hand-written compatibility rule table.** The first cut of this package kept `bb-distributed-data`'s regex rules, re-baselined by hand against the DSQL docs. Comparing that table with `dsql-lint` on the same examples found two errors in the table within minutes (array types and `USING btree` are unsupported) and no case the linter missed. A regex table also cannot parse, so it guesses at literals and comments. #446 had already shown `dsql-lint` working in `bb-distributed-data`'s mock and at synth; this package follows it and adds the rewrite-then-lint order.

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
| `ASYNC` DDL | Runs synchronously | Asynchronous job followed by a poll |
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
4. **A `bb-database copy` command.** The README procedure suffices until copies are a recurring request.
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
| Local engine and schema switching | `src/engines/pglite-cluster.ts`, `src/engines/mock-engine.ts` |
| DSQL compatibility checks and the migration rewriter | `src/dsql-lint.ts`, `src/validation.ts`, `src/migrations/plan.ts` |
| Resumable runner and job waits | `src/migrations/runner.ts` |
| Provisioning and the migration Lambdas | `src/infra/cluster-infra.ts`, `src/migration-lambda.ts` |
| DSQL connection and result type parsers | `src/engines/dsql-engine.ts` |
| Binding record and deploy-time checks | `src/bindings.ts`, `src/deploy-guard.ts`, `src/cli.ts` |
