# Database: design

Status: implemented, preview. Usage is documented in [README.md](./README.md).

## Abstract

`@aws-blocks/bb-database` models a SQL database as a schema on a cluster. A `Database` either owns an Aurora DSQL cluster or attaches to a shared `DatabaseCluster` of type `distributed` (Aurora DSQL) or `provisioned` (Aurora Serverless v2). It can also attach to an existing PostgreSQL through `DatabaseCluster.fromExisting()`. The query interface is identical across these kinds. Capabilities a kind lacks, such as Row Level Security, are rejected by the type checker and again at runtime. One set of migration files serves every kind through a rewriting step. The principal trade-off is that a block is bound to its cluster for its lifetime: changing clusters requires a new block and a data copy, and a deploy-time check enforces this without a production override.

## 1. Introduction

### 1.1 Motivation

AWS Blocks previously offered SQL through two packages, `bb-data` (Aurora) and `bb-distributed-data` (DSQL). Each had its own class, options, migration runner and error set, so moving an application between them required rewriting every call site. Each block also provisioned its own cluster. A second group of tables on Aurora therefore cost a second capacity minimum: 0.5 ACU, about $44 per month at us-east-1 list price. This package replaces both with a single block. The two earlier packages are unchanged.

### 1.2 Requirements

- **R1. Portability.** Application code (queries, transactions, error handling) is unchanged when the cluster kind changes.
- **R2. Early failure.** An operation the kind cannot support fails at compile time. When the kind is known only at runtime, it fails on the dev server before any deploy.
- **R3. Sharing.** Several blocks can share one cluster, each in its own schema, without name collisions.
- **R4. Data safety.** No deploy can silently move a block to a different cluster or destroy a cluster that still holds data.

### 1.3 Out of scope

- **In-place cluster migration.** Moving data between DSQL and Aurora is a copy whose timing depends on the application. The README documents the procedure; the package does not automate it.
- **Emulation of DSQL limits.** A `distributed` cluster retains optimistic concurrency, a 3,000-row transaction limit and the absence of foreign keys. The package reports these early rather than hiding them.
- **Replacement of `bb-data` and `bb-distributed-data`.** Both remain supported, and the umbrella package's `Database` export still refers to `bb-data`.

## 2. Data model

### 2.1 Clusters and blocks

A `DatabaseCluster` exists only as the value of a `Database`'s `cluster` option. A cluster with no block attached serves no request, so it is not itself a Building Block. It has no `bbName`, no vendorize or catalog entry, and no telemetry. Its CDK class extends `BuildingBlockScope` only to declare VPC requirements and to reach the stack's execution role. The `type` value names a category of cluster rather than a product, following the convention established by compute.

`fromExisting()` returns a frozen plain object rather than a construct. Several blocks may share it, and each receives its own schema as on any other cluster.

### 2.2 Schema allocation

A block that owns its cluster uses the `public` schema. A block on a shared cluster uses its id as the schema name unless `schemaName` overrides it. Two blocks on one cluster may not share a schema; the conflict is reported when the second block is constructed. Short ids of `Database` and `DatabaseCluster` are likewise unique per application.

## 3. Type system

### 3.1 Kind inference

`Database<K>` is generic over the cluster kind, and `K` is inferred from the constructor's `cluster` argument. With no `cluster`, `K` is `'distributed'`. A `DatabaseCluster<T>` yields `Database<T>`, and a `fromExisting()` value yields `Database<'external'>`.

### 3.2 Capability restriction

`withRLS()` and `crud()` declare `this: Database<'provisioned' | 'external'>`, so a call on a `distributed` block does not type-check. A cluster held in a variable of union type selects a catch-all overload returning `Database<ClusterKind>`, on which both methods are likewise unavailable. A kind chosen at runtime therefore receives the most restrictive interface. `types.test.ts` asserts each rule with `@ts-expect-error`.

### 3.3 Runtime verification

The runtime does not rely on the static type. Every entry point resolves the `cluster` option into a descriptor, `db.cluster = { kind, id }`, using one shared function in `cluster-ref.ts`. RLS operations check `kind` before running. A type assertion that bypasses §3.2 therefore still fails on the dev server, with the same message as the compile-time error.

## 4. Execution environments

### 4.1 Local execution

Locally, each cluster is one PGlite instance on disk, whether a block owns it or several share it. The dev server therefore has the same layout as AWS: one database, one schema per block.

PGlite provides a single session, which imposes two constraints. First, work is serialized by a mutex held for each auto-commit statement or for an entire `BEGIN … COMMIT`, so one block's `SET search_path` cannot occur inside another block's transaction. Second, a query issued from within a block's own `transaction()` callback joins the open transaction instead of waiting on the mutex. The open transaction is tracked with `AsyncLocalStorage`.

Each local engine is wrapped by `MockEngine`, which implements `simulateConflict()` for every kind. For `distributed` clusters it also applies the DSQL compatibility rules and the per-transaction DDL and row limits. It also refuses DDL on the application connection, matching the DML-only role used on AWS.

### 4.2 Schema scoping on AWS

The engines set `search_path` differently. The pooled engines, DSQL and external `pg`, set it once on each new connection. The RDS Data API used for Aurora has no session. On Aurora, each auto-commit statement outside `public` therefore runs inside a short transaction that first issues `SET LOCAL search_path`. This costs four Data API calls instead of one. Explicit transactions incur the cost once. A block that owns its cluster, or sets `schemaName: 'public'`, incurs no cost.

## 5. Schema migration

### 5.1 Plan construction

Each block has one directory of ordinary PostgreSQL migration files. `buildMigrationPlan` converts them into an ordered list of steps for the target kind. For `distributed` clusters it applies three rewrites:

- `SERIAL` becomes an identity column with `CACHE 65536`;
- `CREATE INDEX` becomes `CREATE INDEX ASYNC` followed by a wait on the index job;
- `ADD CONSTRAINT … CHECK` gains `NOT VALID`, followed by a separate validation step.

Each DDL statement also runs in its own transaction. Statements DSQL cannot execute are rejected; the error names the file and the DSQL documentation page for the rule. For other kinds the DSQL-specific rewrites are omitted, so the same files apply to every kind (R1).

### 5.2 Resumable execution

The runner records progress after each step in a `_migration_progress` table in the block's schema. A file that fails at step 4 of 6 resumes at step 4 on the next run. Replaying earlier steps would re-execute DDL that already succeeded, which DSQL does not run transactionally and so cannot roll back. Completed files are recorded in `_migrations`.

### 5.3 Deployment

Each cluster has one migration Lambda, and each block one CloudFormation custom resource. Resources on the same cluster depend on one another, so blocks migrate sequentially. CDK bundles a function's code when the function is constructed, which precedes the attachment of any block. Migration files therefore cannot be bundled with the Lambda. Instead, each block publishes its files as a single JSON asset in S3, and its custom resource carries the asset's location. A change to the files changes the asset hash, which causes CloudFormation to re-run the resource.

## 6. Cluster binding

### 6.1 Binding record

At its first deploy, a block is bound to its cluster by id and type. The CDK layer writes this record to stack metadata under `aws-blocks:bindings`. The dev server writes the same record to `.bb-data/{fullId}/binding.json` and refuses to start a block whose code disagrees with it. Deleting `.bb-data` resets the local record.

### 6.2 Deploy-time verification

Before `cdk deploy` in the production stage, `bb-database predeploy` synthesizes the application and applies two checks to each stack (R4). Core's deploy script invokes this command when the package is installed.

1. The new binding record is compared with the deployed template. This detects a block moving between two clusters that both retain other blocks, a change CloudFormation does not consider destructive.
2. A change set is created, inspected and deleted. Any `Remove` or `Replace` of an Aurora or DSQL cluster stops the deploy. This detects destructive changes the record does not capture, such as a renamed cluster construct.

The stop message names the resource and states whether its removal policy retains or deletes the data. For Aurora it also gives the monthly cost of the orphaned cluster at minimum capacity. Sandbox stages are exempt from both checks because their clusters are destroyed with the stack.

## 7. Alternatives considered

**Separate blocks per service.** This keeps each block small and introduces no new concepts. It violates R1, because changing service requires rewriting call sites, and R3, because no mechanism shares a cluster.

**Static factory methods** (`Database.dsql()`, `Database.aurora()`). This retains a single class with concise call sites. It exposes service names in the public interface and provides no value that several blocks could share, so R3 would need a second mechanism.

**Runtime-only capability checks.** This removes the constructor overloads and simplifies the types. It violates R2: an invalid `withRLS()` call surfaces at the first request, which for some handlers occurs only in production.

**An override for the binding check.** An environment variable would permit deliberate cluster moves. It weakens R4, since an override set once in a CI configuration persists unnoticed. The sandbox exemption and the documented copy procedure cover the legitimate cases.

## 8. Security and cost

**Security.** On DSQL, the application connects as a per-cluster database role. The migration Lambda creates this role and maps it to the stack's execution role with `AWS IAM GRANT`. The role holds DML privileges on the block's tables only; DDL requires the admin token, which only the migration Lambda holds. Aurora clusters have no network ingress and are reached only through the Data API with Secrets Manager credentials. External connections verify the server certificate by default. Local mode does not verify it, and warns once when `ssl` is omitted. Host-side migrations refuse unverified connections in CI.

**Cost.** A DSQL cluster incurs no cost when idle. An Aurora cluster incurs its minimum capacity regardless of how many blocks share it, which is the main motivation for sharing (R3). Each cluster adds one migration Lambda and one custom-resource provider.

**Observability.** Driver errors retain their SQLSTATE on the server-side `cause`. Only the `DatabaseErrors` name and a fixed message are sent to the client. The migration Lambda logs each applied file and, on failure, the step at which it stopped.

## 9. Behavioral differences between environments

| Area | Local | AWS |
|---|---|---|
| Concurrency | Serialized per cluster (one PGlite session) | Concurrent; DSQL may raise `40001` at commit |
| Cluster options (`minCapacity`, …) | Ignored without a warning | Provision the cluster |
| DSQL feature gaps | Rejected by pattern rules before PGlite (best effort) | Rejected by DSQL (`42501`, reported as `QueryFailed`) |
| `CREATE INDEX ASYNC` | Runs synchronously | Asynchronous job followed by a wait |
| DSQL 10 MiB transaction size | Not enforced (the row limit is) | Enforced |
| 3,000-row transaction limit | Reported as `TransactionRowLimitExceeded` | Reported as `QueryFailed` |
| `simulateConflict()` | Available on every kind | Throws |
| `fromExisting({ host, secretArn })` | Not reachable | RDS Data API |
| Schema scoping on Aurora | Session-level `search_path` | One extra transaction per auto-commit statement outside `public` |

## 10. Limitations and future work

**Known limitations.**

1. On deployed DSQL, exceeding the 3,000-row transaction limit is reported as `QueryFailed`, not `TransactionRowLimitExceeded`. The driver error has not yet been mapped.
2. The local DSQL compatibility rules are pattern-based and can miss constructs that DSQL rejects.
3. Migrations for `fromExisting({ host, secretArn })` are not applied at deploy; they run through `bb-database migrate`.

**Future work.** Each item states the condition for revisiting it.

1. **Safe replacement**, a `replaces` option naming a previous binding. The same need exists for `KVStore`, `FileBucket` and `DistributedTable`, so it warrants one design across data blocks.
2. **Compile-time binding verification** from a lock file written by deploys. The per-application uniqueness of short ids (§2.2) allows a block to be identified by the literal in its constructor. Revisit once deploys can write files back to the repository.
3. **A `bb-database copy` command.** The README procedure suffices until copies are a recurring request.
4. **Multi-region DSQL** (`regions`, `witnessRegion`). Revisit when the feature is scheduled.

## Appendix A. Source map

| Concern | Files |
|---|---|
| Public types and option shapes | `src/types.ts`; constructor overloads in `src/index.mock.ts` |
| Resolution of the `cluster` option | `src/cluster-ref.ts` (shared by all entry points) |
| Queries, transactions and retries | `src/database-core.ts` |
| Local engine and schema switching | `src/engines/pglite-cluster.ts`, `src/engines/mock-engine.ts` |
| DSQL rules and the migration rewriter | `src/validation.ts`, `src/migrations/plan.ts` |
| Provisioning and the migration Lambda | `src/infra/cluster-infra.ts`, `src/migration-lambda.ts` |
| Binding record and deploy-time checks | `src/bindings.ts`, `src/deploy-guard.ts`, `src/cli.ts` |
