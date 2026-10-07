# Database — Design

Design notes for `@aws-blocks/bb-database`. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-database`
**Type:** Primitive (new infrastructure) with a composed shape (`DatabaseCluster` + `Database`)
**AWS services:** Aurora DSQL (`distributed`), Aurora Serverless v2 via the RDS Data API (`provisioned`), any PostgreSQL over the wire protocol (`fromExisting()`)

## Why two classes

This block separates **where the data lives** (a cluster) from **the block that owns a slice of it** (a schema). A `DatabaseCluster` is constructed the way a compute is — `new X(scope, id, { type })` — with a `type` that names a category rather than a product. A `Database` with no `cluster` owns a `distributed` cluster, so the simplest app needs one line.

`DatabaseCluster` is not a Building Block of its own: a cluster with no `Database` on it does nothing, so it carries no `bbName`, has no vendorize or catalog entry, and is not counted in telemetry. Its CDK class extends `BuildingBlockScope` only to declare VPC requirements and reach the stack's execution role and defaults.

Sharing works identically for every kind, including `fromExisting()`: pass the same value, get a schema per block.

## Layers

```
types.ts              public types only (ClusterType, ClusterKind, options, Bindings, plan)
cluster-ref.ts        cluster option → { kind, id } descriptor + schema name (shared by all layers)
registry.ts           unique short ids per app; schema collisions per cluster
bindings.ts           binding record, dev-server marker, diff, stop message
database-core.ts      query/queryOne/execute/transaction + retry, withRLS, crud  (mock + aws)
rls-database.ts       RLSEnabledDatabase / RLSScopedDatabase
engines/              pglite-cluster (local), pg-client (external), dsql (DSQL), data-api (Aurora), mock-engine (decorator)
validation.ts         DSQL compatibility rules, each with its doc page
migrations/plan.ts    the rewriter → MigrationPlan
migrations/runner.ts  runs a plan; _migrations + _migration_progress in the block's schema
infra/cluster-infra.ts  DSQL / Aurora provisioning + one migration Lambda per cluster + per-block CustomResources
infra/bindings-metadata.ts  stack metadata record
deploy-guard.ts       record diff + change-set backstop
cli.ts                migrate --explain, migrate --url, predeploy, guard
```

`index.mock.ts`, `index.aws.ts` and `index.cdk.ts` each define `DatabaseCluster` and `Database`; everything else they export comes from `exports.ts`, so the three entry points cannot drift.

## The type surface

`Database<K extends ClusterKind = 'distributed'>` anchors `K` on `readonly cluster: ClusterRef<K>`. Constructor overloads, most specific first: no options or options without `cluster` → `Database<'distributed'>`; `ProvisionedDatabaseOptions & { cluster: KindOf<K> }` → `Database<'provisioned'>`; the same for external and distributed; a catch-all for a union-typed cluster. `withRLS()` and `crud()` take `this: Database<'provisioned' | 'external'>`, so they are unavailable on `Database<'distributed'>` and on the catch-all. `types.test.ts` pins every rule with `@ts-expect-error`; the generated `.d.ts` keeps the `this` parameter (api-extractor's rollup is disabled in this repo).

Nothing about the kind is read from the type at runtime: every layer calls `resolveCluster()` and checks `ref.kind`.

## Local mode

One PGlite per cluster (`engines/pglite-cluster.ts`), one schema per block:

- The cluster remembers the session's `search_path` and switches only when the next statement belongs to another block.
- Work is serialized with a mutex: an auto-commit statement, or a whole `BEGIN … COMMIT`, holds the lock, so two blocks' statements never interleave inside one transaction. A `db.query()` issued from inside that block's own `transaction()` callback joins the open transaction (tracked with `AsyncLocalStorage`, `engines/tx-scope.ts`) instead of deadlocking.
- `SET` inside an aborted transaction is undone with it, so a rollback forgets the remembered schema.

`MockEngine` wraps every local engine: `simulateConflict()` (every kind), and on `distributed` the DSQL validation layer, the DDL guard on the app connection, `CREATE INDEX ASYNC` → synchronous, and the per-transaction DDL/DML and 3,000-row limits.

`fromExisting({ connectionString })` connects with `pg`, `search_path` set per pooled connection. `fromExisting({ host, secretArn })` (Data API) cannot be reached locally; the error says so.

## Schema scoping on AWS

| Engine | How `search_path` is set |
|---|---|
| `DsqlEngine` (pg pool, IAM token) | `SET search_path` on each new pooled connection |
| `PgClientEngine` (external) | same |
| `DataApiEngine` (Aurora) | the Data API has no session: a non-`public` schema wraps each auto-commit statement in a short transaction that first runs `SET LOCAL search_path`; explicit transactions set it after `BeginTransaction` |

A block on its owned cluster uses `public` and pays none of this.

## Migrations

`buildMigrationPlan(files, target)` splits each file into statements and emits `PlanStep`s. For `distributed`: `SERIAL` → `GENERATED BY DEFAULT AS IDENTITY (CACHE 65536)`, `CREATE INDEX` → `ASYNC` + `wait-index-job` (`CALL sys.wait_for_job(<id>)`, skipped when the engine returns no job id, as PGlite does), `ADD CONSTRAINT … CHECK` → `NOT VALID` + `validate-constraint`, DDL `transactional: false`, DML `transactional: true`; every statement is checked against `validation.ts` and a violation throws `DsqlMigrationValidationError` naming the file and the doc page. For `provisioned` / `external`: every statement is transactional, `ASYNC` is stripped, `CREATE INDEX CONCURRENTLY` runs outside the transaction.

`runMigrationPlan` ensures the schema, `_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP)` and `_migration_progress (name, step)`. Consecutive transactional steps share a transaction; progress is written after each unit of work, so a failed file resumes at the failed step and the error names the step. The file is recorded in `_migrations` and its progress row deleted in one final transaction.

At deploy, `ClusterInfra` creates one `NodejsFunction` per cluster. CDK bundles a function's code when the function is constructed, which is before any block attaches, so migration files are not in the bundle. Each block publishes its files as one single-file S3 asset (`{ fileName: sql }` JSON, uploaded as-is) and grants the Lambda read on it. One `CustomResource` per block carries `migrationsHash`, `migrationsBucket`, `migrationsKey`, `schemaName`, `blockFullId`, `dbRole`, `appRoleArn`; resources on one cluster depend on each other serially. On `distributed` the Lambda also creates the app role, maps it with `AWS IAM GRANT`, and grants `USAGE` on the schema plus DML on its tables.

## The binding rule and the guard

`Bindings` (`databases[fullId] = { cluster, type }`, `clusters[fullId] = { type }`) is written to `stack.templateOptions.metadata['aws-blocks:bindings']`; `'default'` and `'external'` are reserved cluster ids. The dev server writes the same object per block to `.bb-data/{fullId}/binding.json` and stops when the code disagrees.

`bb-database predeploy --stage production` (invoked by `@aws-blocks/core`'s deploy script when the package is installed) synthesizes to a temp directory, then for each stack: `DescribeStacks` (a missing stack is a first deploy), `GetTemplate` → `diffBindings`, then `CreateChangeSet` / `DescribeChangeSet` / `DeleteChangeSet`, stopping on `Remove` or `Replace` of `AWS::RDS::DBCluster` / `AWS::DSQL::Cluster` and naming the resource, whether its policy retains or deletes, and the monthly cost of an orphaned provisioned cluster. The change-set backstop is skipped, with a printed note, when the template exceeds CloudFormation's 51,200-byte inline limit or has a parameter with neither a default nor a deployed value. The sandbox stage runs neither check.

## Mock ↔ AWS differences

| Area | Local | AWS |
|---|---|---|
| Concurrency | serialized per cluster (one PGlite session) | real concurrency; DSQL may raise `40001` at commit |
| Cluster options | ignored silently | provision the cluster |
| DSQL feature gaps | rejected before PGlite by the validation rules (regex-based, best effort) | rejected by DSQL itself (`42501` → `QueryFailed`) |
| `CREATE INDEX ASYNC` | runs synchronously | asynchronous job + wait |
| 10 MiB transaction size | not enforced (row count is) | enforced by DSQL |
| `simulateConflict()` | available | throws |
| `fromExisting({ host, secretArn })` | not reachable | RDS Data API |
| `search_path` on Aurora | session-level | per-statement transaction (Data API has no session) |

## Deferred

Safe replacement (`replaces`), the compile-time binding check, a `bb-database copy` command, multi-region (`regions`, `witnessRegion`), a cluster registry / scope-level default, and running migrations for `fromExisting({ host, secretArn })` at deploy.
