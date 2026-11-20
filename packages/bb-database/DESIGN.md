# Database: design

Status: implemented for `dsql` clusters, `aurora` clusters and existing databases. [README.md](./README.md) documents usage.

## Abstract

`@aws-cdk-blocks/bb-database` models a SQL database as a schema on a cluster. A `Database` runs on one of three kinds of cluster:

- An Aurora DSQL cluster that the block owns. This is the default.
- A `DatabaseCluster` of type `dsql` or `aurora` that several blocks share.
- A PostgreSQL database that already exists (`DatabaseCluster.fromExisting()`).

The query interface is the same on all three. Migration files are written for the cluster's engine, and the block runs them as written. A block is bound to its cluster. To change clusters, add a new block and copy the data.

## 1. Introduction

### 1.1 Motivation

One SQL block per AWS service gives each service its own class, options, migration runner and error names. Moving an application between services then means rewriting every call site, and each block provisions its own cluster. This package is one block, and the cluster is a constructor option.

### 1.2 Requirements

- **R1. Portability.** Application code (queries, transactions, error handling) does not change when the cluster changes.
- **R2. Early failure.** An operation that the cluster cannot support fails at compile time where the type system can express it. Otherwise it fails on the dev server, before any deploy.
- **R3. Sharing.** Several blocks can share one cluster, each in its own schema, without name collisions.
- **R4. Data safety.** No deploy silently moves a block to a different cluster or destroys a cluster that still holds data. This requirement is not met yet (section 6).

### 1.3 Out of scope

- **Moving data between clusters.** The timing of a copy depends on the application. The README documents the procedure, and the package does not automate it.
- **Hiding DSQL's limits.** A `dsql` cluster keeps optimistic concurrency and its per-transaction limits. The package reports them early.

## 2. Data model

### 2.1 Clusters and blocks

A `DatabaseCluster` exists only to be the value of a `Database`'s `cluster` option. It serves no request by itself, so it is not a Building Block. It has no `bbName`, no catalog entry and no telemetry. Its CDK class extends `BuildingBlockScope` only to declare VPC requirements and to reach the stack's execution role.

`type` names a category of cluster, not a product, as the compute blocks do:

- `dsql` is Aurora DSQL.
- `aurora` is Aurora PostgreSQL Serverless v2 created with the express configuration. That is one CloudFormation resource for the cluster and its writer instance, outside any VPC, behind an internet access gateway.

A block that owns its cluster owns a `dsql` cluster. An `aurora` cluster is always a `DatabaseCluster`, so the engine is chosen in one place.

`DatabaseCluster.fromExisting()` returns a reference object, not a construct (section 7).

### 2.2 Schema allocation

A block that owns its cluster uses the `public` schema, and so does a block on an existing database. A block on a shared cluster uses its id as the schema name. `schemaName` overrides either default.

`sanitizeSchemaName` in `src/constants.ts` makes the id a PostgreSQL identifier:

- It lower-cases the id and replaces every character outside `[a-z0-9_]` with `_`.
- It prefixes a leading digit with `_` and replaces a `pg_` prefix with `blocks_`.
- It truncates a name over 63 characters and adds a hash suffix.

Two blocks on one cluster cannot share a schema. The second block fails at construction. The ids of `Database` and `DatabaseCluster` are unique per application for the same reason. These checks are keyed by the application's root: the `BlocksStack` or `BlocksBackend` at synth, and the stack name at runtime. Two backends synthesized in one process therefore do not collide.

## 3. Type system

`Database` and `DatabaseCluster` are not generic.

- `ClusterType` is `'dsql' | 'aurora'`. `DatabaseClusterOptions` is a union discriminated on `type`, so the capacity options exist only on `aurora`, and `snapshot` is a removal policy only there.
- `ClusterKind` is `ClusterType | 'external'`. `db.cluster` is `{ kind, id }`. The type of `kind` is `ClusterKind`, not the literal that the constructor received, so a handler that branches on the kind reads the value.
- `DatabaseOptions` is a union discriminated on `cluster`. An option that belongs to another shape, such as `removalPolicy` next to `cluster`, is a compile error, with no constructor overloads. `types.test.ts` asserts these rules with `@ts-expect-error`.
- Every entry point resolves the `cluster` option with one function in `src/runtime/construction.ts`.

A query's row type can come from a value instead of a type argument. `query()` and `queryOne()`, on the block and on a transaction, accept `{ schema }`. The schema is a [Standard Schema](https://standardschema.dev). Its output type is the result type, and the block validates every row against it (`src/runtime/index.ts`). The block depends only on the specification's types, so the application chooses the schema library.

A row that fails validation raises `ResultValidationFailed`. The message reaches the client and names the row index and the path of the first issue. The library's own issue messages can quote the row's values, so they go on the error's non-enumerable `cause` and stay on the server.

## 4. Execution environments

**Statements join the open transaction.** `DatabaseCore` (`src/runtime/index.ts`) tracks the transaction that a `transaction()` callback runs in with `AsyncLocalStorage` (`src/runtime/tx-scope.ts`). A `query`, `queryOne` or `execute` call on the block that opened the transaction, made inside the callback, runs in that transaction. Without this rule the statement would auto-commit on another pooled connection on AWS, and locally it would wait on the mutex that the transaction holds.

The scope closes with the transaction. A statement from a promise that the callback did not await runs auto-commit. A call on another block does not join. It runs on that block's own engine.

**Conflicts are retried in one place.** `DatabaseCore.transaction()` retries a conflict in local mode and on AWS. With `retryOnConflict` it runs the callback again up to `maxRetries` times (`DEFAULT_MAX_RETRIES`, 8) and waits before each run. The wait is `conflictRetryDelayMs()`, a whole number of milliseconds drawn uniformly from 0 to `min(2000, 50 × 2^retry)`, where `retry` is 0 for the first retry. The ceiling grows so that a busy row gets fewer attempts per second. The wait is random so that transactions that conflicted together do not run again together.

The failed attempt has rolled back and freed its connection before the wait (section 4.3), so a waiting retry holds no connection and no mutex. With the default, the waits add up to 7,150 ms at most. A single auto-commit statement that conflicts takes a separate path with three fixed waits (`AUTOCOMMIT_CONFLICT_BACKOFF_MS`).

### 4.1 Local execution

**One PGlite per cluster.** Locally, each provisioned cluster is one PGlite instance on disk, whether one block owns it or several share it. The dev server has the layout of AWS: one database, one schema per block. An existing database is different (section 7).

**One session.** PGlite has a single session, so a mutex serializes the work. The mutex is held for one auto-commit statement or for a whole `BEGIN … COMMIT`. The block does not use PGlite's own `transaction()`, because that API has no savepoints, and the nesting below needs them.

**Nested work.** A block's own statements inside its `transaction()` callback go to the in-transaction methods (section 4) and never reach the mutex. Another block's statements inside that callback, and a nested `transaction()`, cannot wait for a mutex that the open transaction holds. The `SchemaEngine` nests them in the open transaction:

1. `SAVEPOINT`.
2. `SET search_path` to the nested block's schema.
3. The statement or the callback.
4. `SET search_path` back to the enclosing block's schema.
5. `RELEASE SAVEPOINT`.

On a failure the engine runs `ROLLBACK TO SAVEPOINT`, which also undoes the inner `SET`, and then restores the `search_path`. The enclosing transaction continues.

This differs from AWS, where the call runs on the other block's own connection (section 11). Locally the nested call sees the uncommitted writes of the enclosing transaction and rolls back with it.

**A migration run can be nested too.** A block applies its migrations with its first statement. When that statement is inside another block's callback, the schema, the tables and the `_migrations` rows that the run creates roll back with that transaction. The transaction handle therefore takes rollback listeners (`ClusterTransaction.onRollback`). A `ROLLBACK`, a failed `COMMIT` or a `ROLLBACK TO` the handle's savepoint fires them, and a `RELEASE` hands them to the parent. The local entry point registers a listener that drops the engine that `DatabaseCore` cached, so the next statement builds the engine and applies the migrations again. A failed statement of a sibling block rolls back only to its own savepoint and leaves the engine in place.

**The application role.** The application's statements run as a plain role, `blocks_app_local`, which the cluster creates at init. Migrations run as PGlite's own user, a superuser, in place of the cluster admin. After a block's migrations, the local entry point issues the grants that the migration function issues on AWS. One function serves both (`src/migrations/grants.ts`): DML on the schema's tables, `SELECT` on its views, `USAGE` on its sequences, and nothing on the ledger tables. The role exists before the first migration runs, so a file can grant to it; `${app_role}` in a file is `"blocks_app_local"` here (section 5.2).

PostgreSQL then enforces locally what it enforces on AWS. DDL and `TRUNCATE` in a handler fail with SQLSTATE `42501`. The ledger tables are closed. A Row Level Security policy applies, because the role does not own the tables.

**Switching the session user.** The engine switches the session's user as it switches the `search_path`. It issues `SET SESSION AUTHORIZATION` before a top-level statement or a `BEGIN`, tracks the current user so that an unchanged user costs no statement, sets the user again after a `SAVEPOINT`, and restores it before the `RELEASE`. The statement names the role each time, because `RESET SESSION AUTHORIZATION` does not return a PGlite session to its own user. The statement is `SET SESSION AUTHORIZATION` and not `SET ROLE`, so that a `SET ROLE` in application SQL is checked against the application role's memberships, as on AWS.

**Extensions.** PGlite ships PostgreSQL's contrib extensions as separate bundles, and an instance can create only the ones passed to it at construction. The PGlite of an `aurora` cluster gets the extensions that PGlite 0.5 ships and that Aurora PostgreSQL 16 and 17 list as supported (`AURORA_LOCAL_EXTENSIONS` in `src/engines/pglite-extensions.ts`): `amcheck`, `bloom`, `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `dict_xsyn`, `earthdistance`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`, `lo`, `ltree`, `moddatetime`, `pg_buffercache`, `pg_freespacemap`, `pg_trgm`, `pg_visibility`, `pgcrypto`, `seg`, `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent` and `uuid-ossp`. A migration still runs `CREATE EXTENSION`, as on AWS. The PGlite of a `dsql` cluster gets none, and `dsql-lint` rejects `CREATE EXTENSION` before PGlite sees it.

Left out:

- `file_fdw`, `pageinspect`, `pg_surgery` and `pg_walinspect`. PGlite ships them, and Aurora does not list them.
- `auto_explain`. It is a module loaded with `LOAD`, not an extension; Aurora sets it in a parameter group.
- `pg_stat_statements`. PGlite writes it into `shared_preload_libraries` in the data directory's `postgresql.conf`, and the directory then fails to open without it. `npm run db -- status` opens a copy of the directory without extensions.
- `vector` (pgvector). It is not in the `@electric-sql/pglite` 0.5 package.

`moddatetime`'s bundle also contains `autoinc`, `insert_username` and `refint`. Aurora PostgreSQL 16 and 17 list all three (as `contrib-spi`), so they can be created locally and on AWS, although they are not named in the set above.

The set is loaded at every start, not only when a migration names an extension. A directory whose tables use an extension must load it again on every later start, and the cluster is created before it knows which blocks, and so which migration files, it will serve. A test can also create an extension at run time. The cost, measured on PGlite 0.5.11 (Apple M3 Pro, Node 22, median of six runs): reopening an existing data directory takes about 330 ms with the set and 150 ms without it. A new directory takes about 1.4 s either way, most of it `initdb`.

An extension that is not in the set fails with PostgreSQL's `extension "x" is not available` (SQLSTATE `0A000`). On an `aurora` cluster the cluster adds to that message that PGlite does not include the extension, and the list of the ones it does.

**Rules by cluster type.** `RulesEngine` wraps each local engine and implements `simulateConflict()`.

- On an `aurora` cluster it does nothing else. PGlite is PostgreSQL, as the cluster is, with the extensions above. The PGlite cluster installs no `sys` stub and strips no `ASYNC`, so a DSQL form fails locally as it does on Aurora.
- On a `dsql` cluster it also runs `dsql-lint` on each distinct statement (section 5.1) and enforces the per-transaction limits. It runs the two asynchronous DDL forms synchronously by removing the `ASYNC` keyword. The cluster installs a stub of DSQL's `sys` schema at init: `sys.wait_for_job()` returns `true` and `sys.jobs` is empty. A job wait copied from the AWS examples therefore runs and does nothing.

`src/runtime/construction.ts` checks the cluster options once for every entry point. A capacity or backup value that the service rejects stops `npm run dev` before it stops a deploy.

**How the limits are counted.** The limits apply to explicit transactions and to auto-commit DML statements, before the change commits. A statement that exceeds a limit rolls back, as on DSQL.

- A statement is counted by its kind, not by the method that issued it. An `INSERT … RETURNING` through `query()` counts the rows it changed. A `SELECT` counts nothing.
- Rows that an `ON DELETE CASCADE` foreign key removes are counted. The engine compares the child tables' row counts before and after the statement. `SET NULL` and `SET DEFAULT` fan-out is not counted.
- The 10 MiB limit is an approximation from the statement text and its parameters.

### 4.2 Connections on AWS

**One pool engine.** Both provisioned types use one `pg` pool engine (`src/engines/pg-engine.ts`) that authenticates with IAM tokens. DSQL tokens come from `@aws-sdk/dsql-signer`. Aurora tokens come from `@aws-sdk/rds-signer`, for the application's database role, which the migration function made a member of `rds_iam`.

**One connection contract.** Both services use port 5432, the `postgres` database, and TLS against the public Amazon Trust Services roots. The internet access gateway of the express configuration presents the same certificate chain as DSQL, not the RDS certificate authority. No certificate bundle ships with the block.

**The Aurora pause.** An Aurora cluster at `minCapacity: 0` pauses after five idle minutes with no client connection open. It takes about 20 seconds to answer the next connection. Any open connection prevents the pause, so the pool closes an Aurora connection ten seconds after its last statement. A warm invocation then pays a reconnect, and an idle cluster costs nothing. A DSQL connection is kept for five minutes, because DSQL has no pause.

The ten seconds are a timer. A Lambda execution environment that is frozen after its response runs no timers. Its socket stays open until the environment thaws or is reclaimed, so the pause can come later than five minutes after the last request.

**Connect timeout.** A connect is bounded to 25 seconds, under the handler's deadline. A cluster that is still resuming fails the statement with `ConnectionFailed`. The statement does not run after the caller was answered.

**The IAM connection rate.** A reconnect is an IAM authentication. RDS recommends fewer than 200 new connections a second per cluster. A burst that wakes several hundred containers with empty pools in the same second can reach that rate. The connection then fails with SQLSTATE `28000` and surfaces as `ConnectionFailed`.

**`search_path`.** The pool sets `search_path` on each new connection through pg-pool's `onConnect` hook. The pool awaits the hook before it hands the connection out. A `SET` that fails therefore fails the checkout, and the statement that waits on it reports the error. A block in the `public` schema needs no `search_path`.

**Connection lifetime.** The pool retires a connection after 55 minutes, inside DSQL's 60-minute limit. The pool handles its `error` event, so the failure of an idle client does not end the process.

**Which statements run again.**

- An auto-commit statement runs once more on a fresh connection in two cases. The first is a stale catalog cache, which DSQL reports as SQLSTATE `40001` with `OC001` in the message. The second is a connection that the server closed while it sat idle: SQLSTATE class `08`, `57P01`, or pg's `Connection terminated` error, which has no code.
- An auto-commit statement does not run again when the socket was reset under it (`ECONNRESET`, `EPIPE`). The server may have run the statement already.
- A `BEGIN` runs once more on a fresh connection, because nothing has run yet.
- A statement inside a transaction does not run again. The transaction is aborted, or gone with the connection.

### 4.3 Transaction handle lifecycle

Both engines settle a handle on the first of `commitTransaction()` and `rollbackTransaction()`. A `COMMIT` that fails has already rolled the transaction back on the server, so a failed commit also settles the handle and frees its connection. On AWS that is the pooled client. Locally it is the cluster mutex.

`rollbackTransaction()` on a settled handle does nothing. A statement on a settled handle fails with `TransactionFailed`. `DatabaseCore.runTransaction` and the migration runner both call `commit` and then, on a failure, `rollback`. Under this contract the second call never reaches a connection that another borrower holds. A `BEGIN` or a `ROLLBACK` that fails returns the client to the pool with the error, so the pool discards the connection.

### 4.4 Kysely

`DatabaseDialect` (`src/kysely.ts`, the `@aws-cdk-blocks/bb-database/kysely` entry) is a Kysely dialect over the block's engine. It uses Kysely's PostgreSQL query compiler, adapter and introspector with the block's own driver.

**Kysely is optional.** `src/kysely.ts` is the only module that imports Kysely, which is an optional peer dependency. No entry point of the block imports that module, and `kysely-free.test.ts` fails if one of them loads Kysely. An application that does not use Kysely does not install or load it.

**Connections.** Each Kysely connection is a `Session` (`src/runtime/session.ts`) from `DatabaseCore`. It has the same engine, the same conflict retry for an auto-commit statement, and the same join into the block's open `transaction()` (section 4). Kysely's driver interface passes transaction control as calls, so the block reads nothing from statement text. `beginTransaction` maps to the handle API (section 4.3). An isolation level or an access mode becomes `SET TRANSACTION`, the first statement of the transaction. A savepoint is a statement of the open transaction.

**Row counts.** Kysely expects the number of rows that a statement changed. The engines report it (`RowCountingEngine` in `src/engines/handle.ts`): PGlite's `affectedRows`, and pg's `rowCount` when the command changes data. A `RETURNING` clause or a literal in the statement does not change the count.

**A statement outside a Kysely transaction.** The callback of a Kysely transaction runs outside the block's `AsyncLocalStorage` scope, so no other statement can join that transaction. On AWS a statement on the block or on the root Kysely instance, issued inside that callback, runs on another connection. Locally it would wait for the one session forever. The wait is therefore bounded (`SESSION_TRANSACTION_WAIT_MS`) and ends with a `QueryFailed` whose message names the cause.

**Streaming.** Streaming needs a cursor on one connection. The engine interface has none, so the dialect refuses it.

### 4.5 User-scoped statements

`asUser(user, claims?)` returns a `ScopedDatabase`. It has the block's four statement methods over a second `DatabaseCore`, whose only engine is a `ScopedEngine` (`src/runtime/scoped.ts`).

**One way in.** The wrapper sets the user's claims at the start of every transaction it begins, with `SELECT set_config('request.jwt.claims', $1, true)` and `{ ...claims, sub: userId }`. The setting is transaction-local, so a single statement runs in a transaction of its own. Every path from the scoped object to the database goes through that engine's `beginTransaction`: an auto-commit statement, `transaction()`, and a Kysely connection, whose `Session` comes from the same core. The scoped object holds no reference to the unwrapped engine. Its entry in the internal access channel returns the wrapper.

`as-user.test.ts` checks each path against PGlite. On a recording engine it also checks that no statement runs outside a transaction and that every transaction starts with the claims. `types.test.ts` pins the keys of `ScopedDatabase`, so a new path fails the build until it has a test.

**Identity, not a role.** On a provisioned cluster the application connects as one role that does not own the tables (sections 4.1 and 5.4). Policies already apply to every statement, and the claim says which user a statement is for. The name of the setting is PostgREST's, so a policy written for PostgREST reads the same value. On an existing database the connection role usually owns the tables, so `asRole()` switches the role as well (section 7).

**A statement with no user.** A transaction-local custom setting reverts to the session's value when the transaction ends. When the session has no value, it reverts to an empty string, and `''::jsonb` is an error. Each `aurora` connection therefore gets the session value `{}` when it opens, in the round trip that sets `search_path`. PGlite gets it at init. A policy that compares a column with `->> 'sub'` then gives a statement with no user no rows. Server code that must see every row passes a claim that a policy admits.

**Transaction modes.** PostgreSQL accepts an isolation level only before the first query of a transaction, and the claims statement is a query. `beginTransaction(modes)` on the engines therefore issues `SET TRANSACTION` itself, and the wrapper sets the claims after it (section 4.4).

**Errors.** SQLSTATE `42501` from a statement of a scoped database is `PermissionDenied`, HTTP 403. A policy's `WITH CHECK` refused the row. From any other statement it stays `QueryFailed`, because there it is the application's own mistake, such as DDL in a handler. A row that a `USING` clause hides is not an error.

**Cost and retries.** A scoped auto-commit statement takes four round trips. On a serialization conflict the whole statement is retried, as the block's own statements are. Every scoped statement begins a transaction, so the retry of `BEGIN` on a closed idle connection (section 4.2) covers it.

**Local nesting.** Locally, a statement of another database object inside a `transaction()` callback is a savepoint of the open transaction (section 4.1). A transaction-local setting made in a savepoint outlives its `RELEASE`. The `SchemaEngine` therefore reads the enclosing transaction's claims at the `SAVEPOINT`, sets `{}` for the nested work, and puts the claims back before the `RELEASE`. `ROLLBACK TO` restores them by itself. A nested statement carries its own database's user or none, as it does on AWS on its own connection.

**`dsql`.** DSQL has no Row Level Security. `asUser()` and `asRole()` throw `DatabaseConfigurationError` in local mode and in the Lambda entry point. `db.cluster.kind` is a union (section 3), so no type can carry a compile error.

## 5. Schema migration

### 5.1 The compatibility checker

[`dsql-lint`](https://github.com/awslabs/aurora-dsql-tools/tree/main/dsql-lint) (`src/dialect/lint.ts`) decides whether a statement is valid on DSQL.

**Where it runs.** The block runs it on each migration file, at synth and when the dev server starts. Locally it also runs on each statement that a handler issues, and caches the result per statement text in a map of 2,000 entries that drops the oldest. Statements that run as part of a migration are not checked again, because the file was checked whole.

It does not run on AWS. The lint is a separate call, `lintMigrationFiles`. The local entry point makes it at construction, and the CDK entry point makes it at synth. The migration function only builds and runs the plan (`buildMigrationPlan`, `runMigrationPlan`) over files that passed the lint.

**The binary.** `@aws/dsql-lint` installs a native binary per platform as an optional dependency: macOS, Linux and Windows on x64, and macOS and Linux on arm64. The migration function does not ship it.

**Fixable findings.** dsql-lint marks some findings as fixable: `serial_type`, `index_async`, `foreign_key_not_valid`, `check_not_valid`, `sequence_cache_missing` and `alter_add_unique_collapse`. The block treats them like every other finding. The file stops with the linter's message and suggestion, and the author makes the change (section 5.2). For the identity and sequence rules, the block adds the cache trade-off to the suggestion, which recommends `CACHE 1`.

**The block's own rule.** The block rejects `GRANT … ON SCHEMA public`. dsql-lint 0.2.20 and PGlite both accept it, and DSQL rejects it at run time, because `public` is a system schema that custom roles use without a grant.

**Version.** The baseline is `@aws/dsql-lint` 0.2.20. `validation.test.ts` pins the rule ids that the integration must report and the SQL that it must accept, so an upgrade that changes a rule fails that test.

### 5.2 Plan construction

Each block has one directory of migration files, written for its cluster's engine. The block runs what the file says. It does not change the SQL text, so the file in the repository is the SQL that runs on the cluster. `buildMigrationPlan` only sequences the statements, by cluster kind.

**`aurora`.** Every statement of a file is one step of one transaction. PostgreSQL DDL is transactional, so a file applies entirely or not at all, and there is nothing to resume. The file is not linted.

**`dsql`.** The plan splits each file into statements with the shared lexer, which respects string literals, dollar-quoted bodies and comments. DSQL allows one DDL statement per transaction and no DDL with DML. The plan therefore gives every DDL statement its own transaction, and consecutive DML statements share one. After each of the two asynchronous forms, `CREATE [UNIQUE] INDEX ASYNC` and `ALTER TABLE ASYNC … VALIDATE CONSTRAINT`, the plan adds a wait for the job that DSQL returns. The SQL of every step is a statement of the file.

**An existing database.** The plan is the `aurora` plan, without the checks (section 7).

**One substitution: `${app_role}`.** The plan replaces every occurrence of `${app_role}` in a file with the quoted name of the role that the application's statements run as. That is `blocks_app_{cluster}` on a cluster the block provisions (section 10), `"blocks_app_local"` in local mode (section 4.1), and the connection role on an existing database, which the runner reads with `SELECT current_user` (section 7). It is the only change the block makes to the SQL text. A file must sometimes name that role, as in `GRANT authenticated TO ${app_role}` for `asRole()`, and the name differs between local mode and AWS, and between clusters. Without the placeholder the author would need one file per place, or a file that is wrong in one of them. The replacement is a plain text replacement, in literals and comments too, made in each statement after the file is split, so no character of the role's name is read as SQL or as a replacement pattern, and the form is Flyway's, so a reader recognizes it as a placeholder. PostgreSQL has no `${` token, so the placeholder cannot be valid SQL that a file meant literally: a file that never runs through the block fails with a syntax error, not with a grant to a wrong role. Any other `${…}` is left alone. The checks of section 5.1 see a quoted stand-in in its place. The hash in `_migration_progress` is of the file as written, so it is the same in every place.

An author with a PostgreSQL file can run `dsql-lint --fix` once and review the result.

### 5.3 Resumable execution

**The ledger tables.** `_migrations` records the files that are complete. `_migration_progress` records where a partly applied file stopped. Both are in the block's schema, and the runner's SQL always qualifies them with that schema. A file that changes `search_path`, as the first line of a `pg_dump` file does, cannot redirect them. `ensureMigrationTables` creates both. `_migrations.applied_at` is `TIMESTAMPTZ`.

**The progress row.** One row per partly applied file holds the resume state:

| Column | Meaning |
|---|---|
| `name` | The file. |
| `step` | The next step to run. |
| `job_id` | The DSQL job that the step waits on, when the step is a wait. |
| `file_hash` | SHA-256 of the file text that the completed steps came from. |

The runner writes the row after each step that runs outside a transaction. For a transactional batch it writes the row once, in the batch's own transaction, so the row becomes visible with the `COMMIT`. A file that fails resumes at the recorded step on the next run.

**Error messages count statements.** A failure reads `statement k of n`, where `n` is the number of SQL statements in the file. A failure at a wait step is reported at the `ASYNC` statement that started the job.

**An edited file.** A row whose `file_hash` differs from the current file stops the run with an error that names the file. The recorded step belongs to another text, and the runner does not guess which new step matches it. The author restores the earlier text to finish the file and puts the change in a new file.

**An `aurora` file.** The file is one transaction, so it has no progress row. Its failure message says that nothing from the file was applied and that the file runs again from the start. The `dsql` message says that the runner resumes at the statement.

**A deploy that rolls back.** The plan decides which files exist. A progress row is a fact about the database, so the runner never deletes the rows of files that are absent from the plan. A deploy that fails returns the custom resource to its previous properties, and the previous set of files can run again. That run leaves the rows of unknown files alone. The runner does not replay earlier steps, because DDL on DSQL is not transactional and cannot roll back.

**An `ASYNC` statement that ran without a record.** The progress save can fail after the DDL succeeded. A run that resumes at such a statement reads the catalog before it issues the statement again:

- A valid object completes the statement.
- A missing object lets the statement run.
- For an `INVALID` index or a `NOT VALID` constraint, the runner looks for a running job on that object in `sys.jobs`. It adopts a running job as the job of the wait step. With no running job, it drops the `INVALID` index and issues the statement again.

**A failed job.** A job that `sys.jobs` reports as `failed` fails the file at the `ASYNC` statement, not at the wait. The runner clears the job id and sets `step` back to that statement. When that statement is the first step of the file, the runner deletes the row instead, so the next run accepts an edited file. For an index, the runner also drops the `INVALID` index that DSQL leaves. A failed validation leaves the constraint `NOT VALID` and needs no cleanup. The next deploy issues the statement again after the author has fixed the cause.

**A purged job.** DSQL removes finished jobs from `sys.jobs` after 30 minutes, so a missing row does not mean success. The plan records the index or constraint name on the wait step (`src/migrations/plan.ts`, parsed by `src/dialect/async-ddl.ts`). The runner reads `pg_index.indisvalid` or `pg_constraint.convalidated`. A valid object completes the step. A missing or invalid object is handled like a failed job.

**Local mode.** The wait step does nothing. PGlite runs the asynchronous forms synchronously and returns no job id.

### 5.4 Deployment

**Resources.** Each provisioned cluster has two migration functions, built from one bundle, and one custom-resource provider. Each block has one CloudFormation custom resource. The resources of one cluster depend on one another, so its blocks migrate one at a time. An existing database is different (section 7).

**Files travel as an asset.** CDK bundles a function's code when the function is constructed, which is before any block attaches. The migration files therefore cannot be in the bundle. Each block publishes its files as one JSON asset in S3, and its custom resource carries the asset's location. A change to the files changes the asset hash, and CloudFormation runs the resource again.

**Long jobs on DSQL.** The provider's `onEvent` handler runs the plan until it finishes or reaches a DSQL job that is still running. The `isComplete` handler resumes the plan on every poll, every 30 seconds for up to 55 minutes. The provider's total timeout bounds a long index build, not the ten minutes of one invocation.

**The ten-minute bound on Aurora.** An `aurora` file is one transaction inside one invocation, so it must finish within the function's ten minutes. The invocation's own timeout message names no file. The migration function therefore runs the plan with `boundToInvocation`, and the runner sets PostgreSQL 17's `transaction_timeout` to nine minutes at `BEGIN`. The server cancels the transaction first, with SQLSTATE `25P04`. The error names the file and the statement and says to split the file.

The bound is fixed. It is not the invocation's remaining time, so a second long file in the same invocation can still meet the invocation's own timeout. The express configuration creates the default engine version, which is 17. The dev server does not set the bound.

**CloudFormation's limit.** A stack waits for a custom resource for `ServiceTimeout` seconds, 3600 at most. The block sets that value on each resource. The provider's 55 minutes stay under it, so a deploy that runs out of time ends with the runner's message and not with a timeout from CloudFormation.

**The application role.** Before the plan runs, the handler creates the application role of the cluster if needed and maps it to IAM. On DSQL that is `AWS IAM GRANT` to the stack's execution role. On Aurora it is `GRANT rds_iam`, and the execution role's `rds-db:connect` grant on `dbuser:<cluster resource id>/<role>` admits the role. When the plan is complete, the handler grants the role DML on the schema's tables, `SELECT` on its views and `USAGE` on its sequences (`ensureAppRole` and `grantAppRole` in `src/deploy/migration-lambda.ts`).

The role exists before the first file runs because a file may grant to it: `GRANT authenticated TO ${app_role}` makes `asRole('authenticated')` work (section 7). In `1.0.0-rc.0` the handler created the role after the plan, so on the first deploy of a cluster such a file failed with `role … does not exist`. The schema grants still come last, because they cover the tables that the files create. Both halves are idempotent. The first runs on every invocation: the `isComplete` polls of a DSQL job, a deploy after a failed file, and the deploy of every other block on the cluster. It finds the role in place and repeats the IAM mapping, as every deploy already did. The privileges are the same as before; only their order changed.

**The admin connection.** The functions connect as the cluster admin. On DSQL that is `admin` with an admin token. On Aurora it is the master user `postgres`, which the express configuration creates with IAM authentication and no password. The template does not name `EnableIAMDatabaseAuthentication` or `MasterUserAuthenticationType`. Express sets both, and naming them makes CloudFormation modify the cluster after the create.

**Migrations run before handler code.** A CDK aspect runs at synth, after all constructs exist. It makes every Lambda function that assumes the stack's execution role depend on each block's custom resource. A deploy therefore applies a block's migrations before any new handler code runs.

## 6. Cluster binding

R4 is not met yet. Nothing stops a deploy that renames a `Database` or `DatabaseCluster` id. In production the removal policy of the cluster is `retain` by default, so the old cluster and its data stay. The application then points at a new, empty schema.

The planned mechanism has three parts: a binding record in stack metadata, a marker in `.cdk-blocks/local/data` for the dev server, and a guard that inspects a change set before `cdk deploy`.

**The logical id of an owned cluster.** The cluster of a `Database` that owns it has the CloudFormation logical id `<fullId>DsqlCluster`, without the characters that a logical id cannot have. The id does not come from the construct path. `DistributedDatabase` of `@aws-blocks/bb-distributed-data` declared its cluster under that id. A `Database` with the id of a deployed `DistributedDatabase`, in the same scope and stack, is therefore the same resource to CloudFormation, and the deploy keeps the cluster. The runner reads the `_migrations` table of that block as it is: the table has an extra `id` column with a default. The database role has the same name in both blocks.

Two blocks whose ids give the same logical id fail at synth with an error that names both. A shared `DatabaseCluster` has the logical id of its construct path.

## 7. Existing databases

`DatabaseCluster.fromExisting()` returns `{ type: 'external' }` with either a `name` or the application's own connection string source, and an optional `ca`. A block on it has `cluster.kind === 'external'` and provisions no cluster.

Three properties of an existing database shape this section:

- The block does not own the database.
- The application connects as the role that the connection string names.
- The path from a Lambda function to the database usually goes through a connection pooler in transaction mode.

**Where the connection string is.** With `name`, every layer derives the same SSM SecureString name, `/<stackName>-<name>`, from one function (`dbConnectionParameterName` in `@aws-cdk-blocks/core`):

- The CDK entry point grants the execution role read access to the parameter.
- The Lambda entry point reads the parameter through an `AppSetting` with the first statement.
- `npm run db -- connect --stage <stage>` writes the parameter. It takes the stack name from core's `getStackName()`.

Locally the value is an `AppSetting` under one fixed scope, keyed by the name. The block and the command line reach the same entry without the application's scopes. The value appears in no template, no custom resource property and no log. The migration function receives the name of the parameter.

`AppSetting.put()` and `Secret.put()` store a value as JSON, so a string is held in quotes. `npm run db connect` stores the string as it is. `decodeStoredValue` (`src/external/ssm-store.ts`) reads both forms for the migration function and the command line.

**The driver never sees the connection string.** `pg` merges a connection string over the programmatic config, and a TLS parameter in the string replaces the `ssl` object. For example, `sslmode=no-verify` turns verification off. `src/external/connection.ts` therefore splits the value with `new URL()` into host, port, user, password and database, and refuses the TLS parameters. It also replaces the parser's own error, because that error carries the value in its `input` field. The pool always gets an `ssl` value, `{ ca }` or `true`. With no value, `pg` reads `PGSSLMODE`.

**The certificate authority.** `ca` is an option in code, per connection. `npm run db -- connect --ca <file>` writes it to one module per connection name: `cdk-blocks/database.ca.ts` for the default name, and `cdk-blocks/database.<name>.ca.ts` for another. Every command for that connection verifies the server with that module. A `connect` without `--ca` does the same, so the command checks what the application checks.

**Session state does not cross a transaction pooler.** Through such a pooler, a session `SET` can reach another client or be lost, and a session advisory lock can stay held. Nothing that the block does on an existing database depends on session state:

- `asRole()` and `asUser()` set the identity with `set_config(…, true)`.
- The migration runner sets its limits and a non-`public` `search_path` with `SET LOCAL`.
- The migration runner takes no lock.

The one exception is the `search_path` that the application's statements get for a schema other than `public`. It is a session `SET`, and the README says so.

**Migrations.** The plan is the PostgreSQL plan, with every statement of a file in one transaction. The files are not checked, because they can be older than the block and an applied file cannot change. For this kind the runner also does the following in each file's transaction:

- It sets the limits in one query after `BEGIN`: `idle_in_transaction_session_timeout` always, and `statement_timeout` and `transaction_timeout` (PostgreSQL 17 and later) in the migration function. A run that stops does not keep its locks.
- It does not send a file's own `SET` of one of those limits. Every `pg_dump` file sets them to 0, and a plain `SET` would replace the limit for the rest of the transaction.
- It does not send `SET transaction_timeout` to a server older than PostgreSQL 17, which refuses the parameter.
- It runs `RESET ALL` before the commit, so the session settings of a `pg_dump` file do not stay on a pooled connection.
- It writes the ledger row before the commit, in the same transaction. Of two runs at the same time, one commits. The other fails on the row and rolls back everything its copy of the file did.

The runner uses the ledger table of `@aws-blocks/bb-data` as it is. That table is `_migrations` with an extra `id` column.

**Deploying migrations.** `src/deploy/external-infra.ts` creates two functions, a provider and a custom resource for each block that has migration files, outside any VPC. The files and the `ca` travel as one asset. The resources of two blocks on one database are not chained, so those blocks can migrate at the same time. The migration function runs again after a refusal that passes: a server that is full or starting, or a lookup or connect that timed out. It reports a refused login, a missing database and a certificate that does not verify at once.

**No baseline command.** A schema dump is the work of the user's own tool, such as `pg_dump` or a provider's command line. The block supplies the step that such a tool lacks. `migrate --mark-applied <file>` records a file in the ledger of a database that already has the schema, with one `INSERT … ON CONFLICT DO NOTHING`.

**Local mode is the real database.** PGlite cannot rebuild the schema, roles and data of an existing database from files, so the local entry point opens the same engine as the Lambda entry point. It runs no migration file. Nothing that starts from `npm run dev` changes a schema. `npm run db migrate` is the explicit step, with the runner that the deploy uses.

**Identity.** The connection role usually owns the tables, and PostgreSQL does not apply policies to an owner. The claims of `asUser()` alone filter nothing there. `asRole(role, claims?)` switches the role and sets the claims in one statement at the start of each transaction (`src/runtime/scoped.ts`). The role name is a bound parameter. The block takes no position on which roles exist or what the claims hold.

PostgreSQL allows the switch only when the connection role is a member of the role. When it is not, the first statement fails with `DatabaseConfigurationError`, and the server log names the grant to add as a migration: `GRANT "<role>" TO ${app_role} WITH INHERIT FALSE, SET TRUE;`. The options give the right to switch and nothing else. After a plain grant the connection role inherits the role, and a policy written for the role then applies to a statement outside `asRole()` too; the options need PostgreSQL 16, so the hint says to leave them out on an older database. The migration functions connect as the application does, so `${app_role}` is the connection role and that role exists before any file runs. A provisioned cluster has the same order since the role is created before the plan (section 5.4). The hint used to say `GRANT "<role>" TO CURRENT_USER`. The application cannot run that, since a role cannot grant itself membership, and in a migration on a provisioned cluster `CURRENT_USER` is the cluster admin.

**The claims after a transaction.** The block cannot give each connection a session default for `request.jwt.claims`, because a transaction pooler does not keep it. After a scoped transaction the setting is an empty string on that connection (section 4.5). A policy on an existing database must accept that value, and the README shows the `nullif` form.

**Connections and errors.** The pool connects with a ten-second timeout and closes a connection ten seconds after its last statement. A connection that was never made is `ConnectionFailed`, not `QueryFailed`: the address, the certificate, the login, a missing database, or too many clients. A request does not try again. The driver's text names the host or the role and never the password, and it goes to the function's log. A client that is checked out for a transaction has its own `error` listener, so a connection that ends between two statements does not end the Node process.

**A database behind the RDS Data API.** `fromExisting({ dataApi })` names an Aurora PostgreSQL cluster, a Secrets Manager secret and a database. The engine is `DataApiEngine` (`src/engines/data-api-engine.ts`). It implements the engine interface over the four calls of the Data API: a statement is `ExecuteStatement`, and a transaction handle holds the id that `BeginTransaction` returns. The block opens no connection, so the cluster can stay in a VPC with no path to it.

- The Data API has no session. The block's schema is `public`, and nothing that the block does needs a session (the list above holds).
- The Data API takes one statement in a call. The engine says so (`oneStatementPerCall`), and the migration runner then sends its settings one by one.
- An error of the service gets the SQLSTATE that the block's translation reads. The server's own code is at the end of the message. A cluster that resumes, or a service that cannot answer, is `57P03`, which a migration run tries again. A credential that the server refused is `28P01`.
- A statement outside a transaction is sent again after an answer that says it did not run and that passes: a paused cluster that resumes (up to 24 seconds of waits, inside the deadline of a request), and a credential that the server refused, which a rotation of the secret causes. A statement in a transaction is not sent again.
- A placeholder `$n` in a string, a quoted identifier, a comment or a dollar-quoted body is not a parameter, as on a PostgreSQL connection. The Data API itself does not bind a name inside a string.
- The service reports no changed rows for a statement with `RETURNING`. The engine counts the rows that such a statement returned.
- A commit that fails is followed by a rollback. A commit that did not reach the server would otherwise leave the transaction open, with its locks, until the service ends it.
- The service ends a statement after 45 seconds. The migration runner has no way around that limit, so a statement that needs longer is not for a migration file here.
- Parameters and results have the forms that `Database` of `@aws-blocks/bb-data` gave them, so an app that moves from that block reads the same values.

**The cluster of the earlier block.** `LegacyDatabaseCluster` declares the Aurora cluster of `Database` in `@aws-blocks/bb-data` 0.5.0. `src/legacy/aurora-infra.ts` is that release's infrastructure function, without its migration function, and `src/legacy/aurora-cluster.ts` is how that release turned its options into the function's arguments. Both files are frozen. The construct has the id and the scope of the earlier `Database`, so every logical id is the one in the deployed stack, and CloudFormation changes none of the resources.

The cluster is a provisioned cluster to the block, of type `aurora`, with two differences. On AWS the engine is `DataApiEngine`, with the cluster ARN, the secret ARN and the database name from the config keys of the earlier block. The migration resources are those of an existing database, so the runner uses the ledger of the earlier block and applies no DSQL check. Locally the cluster is PGlite, as a `DatabaseCluster` of type `aurora` is.

The statements run as the user of the cluster's secret, which owns the tables. The block creates no application role there, so Row Level Security policies apply only through `asRole()`. `asUser()` is an error on this cluster, in local mode too: locally the statements run as a role that owns nothing, so `asUser()` would filter rows there and not on AWS. The block's migration files get no check, at synth and locally, because they are older than the block.

## 8. Command line

The package has one binary, `bb-database`. `npm run db` runs it from the project root. The wrapper passes the arguments as typed and adds two environment variables: `BB_DATABASE_COMMAND`, the name for the usage text, and `BB_DATABASE_START_DIR`, the directory where the runner started (the app directory for npm scripts). The binary resolves the paths in its own options from that directory, so the wrapper keeps no list of those options.

**An existing database.** `connect`, `migrate`, `types` and `status` work on the database of a stored connection string. `connect` reads the string from a hidden prompt or from stdin. The string is never an argument, and the binary removes it and its password from everything it prints.

**A block that provisions its cluster.** The schema of such a block is its migration files, and its local database is PGlite.

- `types --block <id>` applies the block's migration files to a new PGlite database in a temporary directory and reads the columns from it. It uses `prepareLocalSchema` (`src/migrations/local.ts`), the function that the local entry point runs before a block's first statement. The result does not depend on `.cdk-blocks/local/data/`, and a running dev server is not touched.
- `status --block <id>` needs the block's real local ledger. PGlite takes one process, so the command copies the PGlite directory and opens the copy. With a dev server running, it shows what that process had written to disk.

Neither command reads a deployed cluster.

## 9. Alternatives considered

**Separate blocks per service.** Each block stays small and adds no new concept. It fails R1, because a change of service means rewriting call sites, and R3, because nothing shares a cluster.

**Static factory methods** (`Database.dsql()`, `Database.aurora()`). One class with short call sites. It puts service names in the public interface and gives no value that several blocks can share, so R3 needs a second mechanism.

**A hand-written table of compatibility rules.** A table of regular expressions cannot parse SQL, so it guesses at literals and comments, and someone must update it by hand for each DSQL release. `dsql-lint` parses the SQL and follows DSQL releases.

**Rewriting PostgreSQL migrations into DSQL at deploy time.** An application written for PostgreSQL keeps its files. The SQL that runs is then not the SQL in the repository, and a reviewer cannot see it. The rewrite also has to choose values that the author did not write, such as a sequence cache size.

**A regular expression that refuses DDL in local mode.** It cannot enforce a Row Level Security policy or close the ledger tables. A real application role does both (section 4.1).

**A configuration error for a call to another block inside a local transaction.** It rejects code that is correct on DSQL, such as a read of another block's table inside a transaction. The savepoint keeps that code working locally (section 4.1).

**The literal role name in migration files** (`GRANT authenticated TO blocks_app_main`). It needs no substitution, and `getSdkIdentifiers(db).roleName` gives the name. The name differs in local mode (`blocks_app_local`) and is hashed when the cluster's id is long, so the author would need one file for local mode and another for AWS, and a renamed cluster would break the file (section 5.2).

**The same role name in local mode as on AWS.** One literal name would then work in both places. Local mode would need a role per cluster in every PGlite data directory, which changes what is on disk for existing projects, and the name would still be derived from an id that the author does not see.

**A session setting that a `DO` block reads** (`EXECUTE format('GRANT authenticated TO %I', current_setting('blocks.app_role'))`). It leaves the file text alone. It needs PL/pgSQL, which DSQL does not run, and a one-line grant becomes a block of procedural code.

**`CURRENT_USER` in place of the name.** It needs no substitution. In a migration on a provisioned cluster it is the cluster admin, not the application role, so the grant goes to the wrong role.

**A role switch for each transaction on a provisioned cluster,** as PostgREST does. It adds cluster roles, a grant for each table and a reorder of the migration function. It changes nothing on a cluster where the block already connects as a role that owns nothing (section 4.5).

**A Kysely adapter in the block's root entry.** Every application then installs and loads Kysely. The dialect has its own entry, so only an application that imports it loads Kysely (section 4.4).

**A `pg`-pool-shaped object for Kysely's own `PostgresDialect`.** It needs no Kysely import. It has to read `begin`, `commit` and `rollback` out of statement text and invent a command tag so that Kysely's `pg` driver counts affected rows. It also looks like a `pg` pool to libraries that it does not support. Kysely's driver interface is the documented extension point.

**Waiting for DDL jobs inside one Lambda invocation.** One handler instead of two. A Lambda function runs for at most 15 minutes, and an index build on a large table can take longer. The provider's `isComplete` polling has 55 minutes, the most that CloudFormation's one-hour wait for a custom resource allows.

**A lock for migrations on an existing database.** A session advisory lock does not survive a transaction pooler. The ledger row in the file's own transaction gives the same guarantee without a lock (section 7).

**A command that writes a baseline file.** The dump of a hosted database contains objects that the provider owns, and the list differs by provider. The provider's own tool knows that list (section 7).

## 10. Security and cost

**Security on a provisioned cluster.** The application connects as a database role per cluster, `blocks_app_{clusterId}`, through one connection pool per block. The migration functions create this role and map it to IAM (section 5.4). No password exists: no Secrets Manager secret and no connection string.

The name is `blocks_app_` and the cluster's full id with every character other than a letter or a digit replaced by `_`, in lower case. A name longer than 63 characters becomes `blocks_app_` and the first 12 hex characters of the SHA-256 of the full id (`sanitizeDbRoleName` in `src/constants.ts`). `getSdkIdentifiers(db).roleName` returns it, and a migration names it with `${app_role}` (section 5.2).

The role holds `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the block's tables, `SELECT` on its views, `USAGE, SELECT` on its sequences, and `USAGE` on the schema when it is not `public`. It holds nothing on `_migrations` and `_migration_progress`. DDL needs the admin token, which only the migration functions hold. On DSQL the execution role has `dsql:DbConnect` on the cluster, and the migration functions have `dsql:DbConnectAdmin`.

The storage of an `aurora` cluster is encrypted with an AWS-owned key. The express configuration encrypts every cluster and accepts no key choice, and the service rejects `StorageEncrypted` in the template. An application that needs a customer managed KMS key needs the full configuration, which this block does not create.

**Security on an existing database.** The connection string holds a password. It is an SSM SecureString, or a value in the application's own `AppSetting` or `Secret`. The execution role and the migration functions can read that one parameter or secret. The block always verifies the server certificate. What the application can do in the database is decided by the role in the connection string, not by the block (section 7).

**Cost.** A DSQL cluster costs nothing when idle. An `aurora` cluster at `minCapacity: 0` pauses after five idle minutes and costs nothing while paused. The next connection then takes about 20 seconds. `0.5` ACU keeps the cluster warm. Each cluster adds two migration functions and one custom-resource provider, which run only during deploys. A `Database` that owns its cluster uses one DSQL cluster of the default quota of 20 per account and Region. Database blocks on a shared `DatabaseCluster` count once.

**Observability.** A driver error keeps its SQLSTATE on the server-side `cause`. The client receives only the `DatabaseErrors` name and a fixed message. The migration functions log each applied file, each job that they wait on, and the step at which a failed run stopped.

## 11. Differences between local mode and AWS

Provisioned clusters:

| Area | Local | AWS |
|---|---|---|
| Concurrency | Serialized per cluster (one PGlite session) | Concurrent. DSQL can raise `40001` at commit. Aurora raises it under `SERIALIZABLE` only |
| DSQL feature gaps (`dsql` only) | `dsql-lint` rejects them before PGlite | DSQL rejects them (`42501`, reported as `QueryFailed`) |
| PostgreSQL features of an `aurora` cluster (triggers, PL/pgSQL, extensions) | PGlite runs them, with the extensions in section 4.1. An extension that PGlite lacks, such as `vector`, fails locally first | Aurora PostgreSQL 17 |
| `ASYNC` DDL | Runs synchronously. The job wait does nothing. `sys.wait_for_job()` returns `true` and `sys.jobs` is empty | DSQL returns a job id. The runner polls `sys.jobs` every 30 seconds for up to 55 minutes |
| 3,000-row and 10 MiB transaction limits (`dsql` only) | Enforced by `RulesEngine`, cascades counted, size approximated | Enforced by DSQL (`54000`). Both are reported as `TransactionRowLimitExceeded` |
| `simulateConflict()` | Available | Throws |
| `bigint` results | PGlite returns a `number`, or a `BigInt` beyond ±2^53 | `pg` returns a string. `pg-engine.ts` installs a parser that matches PGlite |
| An `ApiError` or a branded AWS CDK Blocks error thrown inside `transaction()` | Passes through unchanged after the rollback | Same |
| A statement on the block inside its own `transaction()` callback | Runs in the transaction | Same |
| Another block on the same cluster, a nested `transaction()`, or a Kysely transaction, called inside a `transaction()` callback | A savepoint of the open transaction: it sees the open transaction's writes and rolls back with it | Runs on its own connection and commits on its own |
| A statement on the block or on the root Kysely instance, inside the callback of a Kysely transaction | Fails after five seconds with `QueryFailed` (section 4.4) | Runs on another connection, outside the transaction |
| The user of a statement nested in another database object's `transaction()` | Its own database's user or none (section 4.5) | The same, on its own connection |
| `SET SESSION AUTHORIZATION` in application SQL | Accepted. The login user of the session is PGlite's superuser | Refused. The application role is not a superuser |
| The application role's name (`getSdkIdentifiers(db).roleName`, `${app_role}` in a migration) | `blocks_app_local` | `blocks_app_{cluster}` (section 10) |

An existing database:

| Area | Local | AWS |
|---|---|---|
| Engine | The real database, through the `pg` pool engine | The same |
| Migrations | Not run by `npm run dev`. `npm run db migrate` runs them | The migration function runs them during the deploy |
| `request.jwt.claims` on a connection after a scoped transaction | An empty string | The same |

## 12. Limitations and future work

**Known limitations.**

1. `dsql-lint` checks syntax, not the catalog. A statement that is valid SQL but wrong for the schema fails on DSQL, not locally. Examples are a cascade past 3,000 rows and a duplicate key during an index build.
2. `RulesEngine` counts `ON DELETE CASCADE` fan-out toward the row limit but not `SET NULL` or `SET DEFAULT`. It approximates the 10 MiB limit from statement and parameter sizes.
3. A `CREATE INDEX` or a constraint validation that DSQL fails leaves the index `INVALID` or the constraint `NOT VALID`. The deploy fails with the job's details. The fix is to repair the data and deploy again.
4. The pool closes an Aurora connection after ten idle seconds even when `minCapacity` is above 0, where there is no pause to protect.

**Future work.** Each item states when to revisit it.

1. **More providers for an existing database.** Supabase is the tested provider for a connection string. An Aurora cluster with the Data API needs no network path (section 7). Amazon RDS without the Data API needs a function inside a VPC, and its certificate authority is in the Lambda runtime but not in Node's trust store. Revisit on the first request.
1. **The command line for a Data API source.** `connect`, `migrate`, `types` and `status` work with a stored connection string only. Revisit on the first request.
2. **A second, less privileged connection string for the application,** while migrations keep the owner's. Revisit on the first request.
3. **Safe replacement,** a `replaces` option that names a previous binding. `KVStore` and `FileBucket` have the same need, so it needs one design across the data blocks.
4. **Compile-time binding verification** from a lock file that deploys write. The ids are unique per application (section 2.2), so the literal in a constructor identifies a block. Revisit when deploys can write files back to the repository.
5. **A copy command.** The README procedure is enough until copies are a recurring request.
6. **Multi-region DSQL** (`regions`, `witnessRegion`). Revisit when the feature is scheduled.

## Appendix A. Source map

| Concern | Files |
|---|---|
| Public types and option shapes | `src/types.ts` |
| Constructor checks: the `cluster` option, unique ids and schemas | `src/runtime/construction.ts` |
| Queries, transactions, retries and result schema validation | `src/runtime/index.ts`, `src/runtime/tx-scope.ts` |
| Kysely dialect and its connections | `src/kysely.ts`, `src/runtime/session.ts` |
| User-scoped and role-scoped statements (`asUser()`, `asRole()`) | `src/runtime/scoped.ts` |
| Error names and the mapping from SQLSTATE | `src/errors.ts` |
| Connection pool, IAM token passwords, result type parsers | `src/engines/pg-engine.ts` |
| Engine interfaces and transaction handles | `src/engines/handle.ts` |
| The engine of a database behind the RDS Data API | `src/engines/data-api-engine.ts` |
| The cluster of `@aws-blocks/bb-data` 0.5.0 (frozen) | `src/legacy/aurora-infra.ts`, `src/legacy/aurora-cluster.ts` |
| Local engine, schema and role switching, the `sys` stub | `src/engines/pglite-cluster.ts` |
| Local rules by cluster type | `src/dialect/rules-engine.ts` |
| DSQL rules: the linter wrapper, the block's own rule, statement classification, the transaction limits | `src/dialect/lint.ts`, `src/dialect/validation.ts` |
| Asynchronous DDL: name parsing, catalog check, invalid-index cleanup | `src/dialect/async-ddl.ts` |
| Plan sequencing by kind, the `${app_role}` substitution | `src/migrations/plan.ts` |
| Runner, ledger tables and job waits | `src/migrations/runner.ts` |
| The application role's grants | `src/migrations/grants.ts` |
| Schema preparation in local mode | `src/migrations/local.ts` |
| Existing databases: connection string parsing, the engine, the local store, the stored value | `src/external/connection.ts`, `src/external/engine.ts`, `src/external/local-store.ts`, `src/external/ssm-store.ts` |
| Provisioning and the migration functions | `src/deploy/cluster-infra.ts`, `src/deploy/external-infra.ts`, `src/deploy/migration-lambda.ts` |
| Command line | `src/cli.ts`, `src/cli/commands.ts`, `src/cli/owned.ts`, `src/cli/types-file.ts`, `src/cli/io.ts` |
| Test helpers and the internal access channel | `src/testing.ts`, `src/runtime/internal.ts` |
