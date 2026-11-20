# @aws-cdk-blocks/bb-database

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: docs: the errors table gives the `error.name` a caller sees (`QueryFailedException`, not `QueryFailed`), and the README has a table of the `transaction()` options.
- Updated dependencies [cad7bb8]
- Updated dependencies [0b422ee]
- Updated dependencies [0b422ee]
- Updated dependencies [0b422ee]
  - @aws-cdk-blocks/core@1.0.0-rc.2
  - @aws-cdk-blocks/bb-app-setting@1.0.0-rc.2
  - @aws-cdk-blocks/bb-logger@1.0.0-rc.2

## 1.0.0-rc.1

### Minor Changes

- c42ba42: **Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

  To upgrade an existing app:

  1. Move the config file: `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`. Then delete the empty `.blocks/` folder. Do not run `git mv .blocks .cdk-blocks`, because it nests the old folder inside the new one when `.cdk-blocks/` already exists.
  2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`. Without this change, `getSecret()` and `getConfig()` lose their key types.
  3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

  Local data, the local database included, is copied to the new location the first time each block opens its store. `.bb-data/` stays in place. `.cdk-blocks/local/` ignores itself, so it needs no `.gitignore` rule.

  An app that still has `.blocks/config.json` deploys and destroys as before. The telemetry first-run notice prints once more after the upgrade. Pull request #1607 has the full notes.

### Patch Changes

- e529b00: `asRole()` now works after the first deploy of a cluster that `Database` provisions. The app's database role is created before the migration files run, so a migration can grant a role to it. Before, that grant failed with `role … does not exist`, and `asRole()` failed until a second deploy.

  In a migration file, write the app role as `${app_role}`, for example `GRANT authenticated TO ${app_role} WITH INHERIT FALSE, SET TRUE;`. It resolves to the role that the app's statements run as on AWS, in local mode, and on an existing database. `getSdkIdentifiers(db)` now returns that role as `roleName` on a cluster the block provisions.

- e529b00: A migration on a local `aurora` cluster can now run `CREATE EXTENSION` for the contrib extensions that PGlite ships and Aurora PostgreSQL supports, such as `citext`, `pgcrypto`, `pg_trgm`, `hstore`, and `uuid-ossp`. Before, it failed under `npm run dev` with `extension "citext" is not available`. An extension that PGlite does not ship, such as `vector`, still fails locally, and its error now lists the extensions that are available. A `dsql` cluster is unchanged.
- c9d73a8: docs: the `KVStore` and `Database` README examples now import from `aws-cdk-blocks`, which every scaffolded app depends on, so a copied example compiles. The `/kysely` and `/testing` entry points still come from `@aws-cdk-blocks/bb-database`.
- Updated dependencies [e529b00]
- Updated dependencies [fbe48c5]
- Updated dependencies [c42ba42]
- Updated dependencies [3081521]
- Updated dependencies [23692f1]
  - @aws-cdk-blocks/core@1.0.0-rc.1
  - @aws-cdk-blocks/bb-app-setting@1.0.0-rc.1
  - @aws-cdk-blocks/bb-logger@1.0.0-rc.1

## 1.0.0-rc.0

### Major Changes

- e50b9e9: Rename every published package from the `@aws-blocks` scope to `@aws-cdk-blocks`. The umbrella package is now unscoped: `@aws-blocks/blocks` becomes `aws-cdk-blocks`.

  No export or option moved. To upgrade, replace the dependency names in `package.json` and the specifiers in every import:

  ```diff
   {
     "dependencies": {
  -    "@aws-blocks/blocks": "<your range>",
  -    "@aws-blocks/core": "<your range>"
  +    "aws-cdk-blocks": "<your range>",
  +    "@aws-cdk-blocks/core": "<your range>"
     }
   }
  ```

  ```diff
  -import { KVStore } from '@aws-blocks/blocks';
  +import { KVStore } from 'aws-cdk-blocks';

  -import { ApiNamespace } from '@aws-blocks/core';
  +import { ApiNamespace } from '@aws-cdk-blocks/core';
  ```

  Warning IDs reported at synth carry the package name, so they now start with `@aws-cdk-blocks/` instead of `@aws-blocks/`: update any `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the new prefix. An acknowledgement left on an old ID silently stops matching, the warning comes back, and `cdk synth --strict` fails on it.

  The `cdk-blocks` CLI binary, the `aws-blocks` keyword used to discover third-party blocks, and the `aws-blocks` manifest key that carries the `native` and `vendorize` declarations are all unchanged, so a published third-party block is still discovered and still loads its manifest without a republish. A block that depends on `@aws-blocks/core` brings its own copy of core alongside the app's `@aws-cdk-blocks/core`, which is two module instances; block authors should move the dependency to `@aws-cdk-blocks/core`.

  The CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` keeps its name too. `LegacyDatabaseCluster` reads it out of your `cdk.json`, where apps scaffolded before the cutover already set it, and no package was ever published under a `@aws-cdk-blocks/bb-data` name. Renaming the key would leave `StorageEncrypted` unset on a cluster deployed with it on, which CloudFormation answers by replacing the cluster. Keep the key as it is.

  The old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- 06355de: `DatabaseCluster` gains `type: 'aurora'`: Aurora PostgreSQL Serverless v2 created with the express configuration. The cluster is created in seconds together with its writer instance, runs outside any VPC behind an internet access gateway, scales to zero (`minCapacity: 0`, the default) and is reached with IAM authentication only; the master user has no password and the app connects as its own database role with a short-lived token. `minCapacity` and `maxCapacity` set the ACU range, `pointInTimeRecovery` the backup window, and `removalPolicy` accepts `'snapshot'`.

  Blocks on an `aurora` cluster get all of PostgreSQL: triggers, PL/pgSQL, extensions, Row Level Security, transactions of any size. Their migration files are PostgreSQL and run as written, one transaction per file; `dsql-lint` and the DSQL transaction limits apply to `dsql` clusters only, locally and on AWS. An `aurora` migration file that carries a DSQL-only form (`ASYNC`, `sys.wait_for_job()`) is stopped before it runs, with a message that names the file and what to change; the error for a rejected migration file is now `MigrationValidationError` for both kinds. `npm run dev` prints one line per migration run that applied files, naming the schema and the data directory. `db.cluster.kind` is now `'dsql' | 'aurora'`. `DsqlDatabaseOptions` is renamed `SharedDatabaseOptions`.

  On AWS an `aurora` migration file must finish within the migration function's ten-minute invocation: a longer transaction is cancelled by the server and the error names the file and the statement, and a failed `aurora` file reports that nothing from it was applied and that it runs again from the start. Storage is encrypted with an AWS-owned key; the express configuration accepts no customer managed KMS key.

- 7c1eec5: An app that deployed a SQL block of an earlier release keeps its database.

  **`DistributedDatabase`.** A `Database` that owns its Aurora DSQL cluster declares the cluster under the CloudFormation logical id that `DistributedDatabase` of `@aws-blocks/bb-distributed-data` used, `<fullId>DsqlCluster`. An app that changes a `DistributedDatabase` to a `Database` with the same id, in the same scope and stack, keeps its cluster and its rows on the next deploy. `Database` reads the `_migrations` table that `DistributedDatabase` wrote, so an applied migration file does not run again. The guide `docs/guides/upgrading-older-apps.md` has the steps.

  Two `Database` blocks that each own a cluster, with ids that differ only in characters a logical id cannot have (`db-a` and `dba` in one scope), now fail at synth with an error that names both.

  **`Database` of `@aws-blocks/bb-data`.** `LegacyDatabaseCluster` keeps the Aurora cluster of `Database` in `@aws-blocks/bb-data` 0.5.0 in the stack, with its secret and its VPC, under the same CloudFormation logical ids. An app that deployed that block gives the `LegacyDatabaseCluster` the id and the options of its old `Database`, and passes it as the `cluster` of a `Database` with a new id. The deploy changes nothing in the cluster, and the new `Database` uses its tables and its `_migrations` table. Row Level Security policies apply through `asRole()`; `asUser()` is an error on this cluster. The class is deprecated and frozen. The README section "Upgrade from `@aws-blocks/bb-data`" has the steps.

  **An Aurora cluster through the RDS Data API.** `DatabaseCluster.fromExisting({ dataApi: { clusterArn, secretArn, database } })` puts a `Database` on an Aurora PostgreSQL cluster that the block reaches through the RDS Data API. The block opens no connection, so the cluster can stay in a VPC, and the credentials stay in the Secrets Manager secret. The execution role and the migration Lambdas get the Data API actions on that cluster and the read of that secret. The block's schema is `public`, each statement is one HTTPS call, the Data API ends a statement after 45 seconds, and a result is limited to 1 MB. The README section "An Aurora cluster through the Data API" lists the differences from a connection string.

- f45b407: `@aws-cdk-blocks/bb-database/kysely` exports `DatabaseDialect`, a Kysely dialect for a `Database`: `new Kysely<Tables>({ dialect: new DatabaseDialect(db) })`. Kysely is an optional peer dependency of the block; the application installs it. Statements run through the block's engine, so they use the block's schema and fail with the same `DatabaseErrors` names, and affected-row counts come from the engine. A Kysely statement inside the block's `transaction()` callback runs in that transaction. Inside a Kysely transaction, run every statement on `trx`; in local mode a statement on the block or on the root Kysely instance fails after five seconds instead of waiting. Streaming is not supported.

  The entry points of `@aws-cdk-blocks/bb-database` no longer load Kysely. The block imported the root of `@aws-blocks/data-common`, which loads the Kysely adapter. It now imports the new `@aws-blocks/data-common/core` entry, which has every root export except `createKyselyAdapter()`. The root entry of `@aws-blocks/data-common` is unchanged.

- 4e41c28: feat(bb-database): add `@aws-cdk-blocks/bb-database`, a preview of one `Database` block that runs on a cluster

  - `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'dsql'`) with one schema per block. Migrations are written in DSQL, as AWS documents it, and run as written: every file is checked with AWS's `dsql-lint` locally and at synth (a PostgreSQL spelling such as `SERIAL` or `CREATE INDEX` without `ASYNC` stops the deploy with the linter's suggestion), each DDL statement runs in its own transaction, and the runner waits for the jobs that `ASYNC` statements start, resumes a failed file at the failed step (a failed `ASYNC` job rewinds to its statement and drops the `INVALID` index it left, and a job purged from `sys.jobs` is verified in the catalog), and refuses a file that was edited after a partial run (restore the text to finish it, and put the change in a new file); app functions wait for a block's migrations, and DSQL jobs are polled for up to 55 minutes, inside the one hour CloudFormation waits for a custom resource.
  - `aws-cdk-blocks` does not depend on or re-export the block yet; import from `@aws-cdk-blocks/bb-database`.
  - `query()` and `queryOne()` take `{ schema }`, a Standard Schema (Zod, Valibot, ArkType) that types the result from a value and validates every row; a mismatch is `DatabaseErrors.ResultValidationFailed`, whose message names the row index and the field while the library's issue text stays on the server. The same option is on the `tx` a `transaction()` callback receives.
  - An `ApiError` or any branded Blocks error thrown inside `transaction()` reaches the caller unchanged (a 404 stays a 404); only other errors become `TransactionFailed`.
  - `db.query()`, `db.queryOne()` and `db.execute()` called inside the block's own `transaction()` callback run in that transaction, locally and on DSQL.
  - Locally, a call to another block on the same cluster from inside a `transaction()` callback runs inside that transaction as a savepoint instead of waiting on the single PGlite session; on DSQL it runs on its own connection. The README's Local mode section describes the difference.
  - `bigint` results (identity columns, `count(*)`, `sum()` over integers) are JavaScript numbers on DSQL as they are locally; a value beyond ±2^53 is a `BigInt` in both.
  - The test helper `simulateConflict(db)` lives in `@aws-cdk-blocks/bb-database/testing`; the block's runtime class exposes only `query`, `queryOne`, `execute`, `transaction`, `cluster` and `schemaName`.
  - A renamed `Database` or `DatabaseCluster` id keeps the old cluster and its data under the default `retain` removal policy, but points the app at a new, empty one. The deploy guard that stops such a move is a separate change.

- c67048e: feat!: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block

  **Breaking change.** `aws-cdk-blocks` exports `Database`, `DatabaseCluster`, `DatabaseErrors` and `sql` from `@aws-cdk-blocks/bb-database`. The packages `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data` and `@aws-blocks/data-common` are not part of AWS Blocks any more. There is no compatibility layer.

  ```ts
  import { Database, DatabaseCluster, sql } from "aws-cdk-blocks";

  const orders = new Database(scope, "orders"); // owns an Aurora DSQL cluster

  const cluster = new DatabaseCluster(scope, "main", { type: "aurora" }); // Aurora PostgreSQL Serverless v2
  const users = new Database(scope, "users", { cluster });
  ```

  - **`Database`** owns an Aurora DSQL cluster when it has no `cluster` option. A `DatabaseCluster` of type `'dsql'` or `'aurora'` holds several `Database` blocks, each in its own schema. Migrations are ordered `.sql` files in `cdk-blocks/migrations/<id>/`.
  - **Not exported any more:** `DistributedDatabase`, `DistributedDatabaseErrors`, `DistributedDatabaseOptions`, `Database.fromExisting()` and `ExternalDatabaseRef` (an existing PostgreSQL database is now `DatabaseCluster.fromExisting()`, passed as `cluster`). `withRLS()` is replaced by `asUser()` and `asRole()`. `crud()` has no equivalent in `@aws-cdk-blocks/bb-database`. For Kysely, use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely`.
  - **`getSdkIdentifiers(db)`** returns `clusterId` and `schemaName`, plus `clusterEndpoint` and `region` in a deployed Lambda. `getSdkIdentifiers(cluster)` returns `clusterEndpoint`.
  - **Data is not moved.** A `Database` that takes the place of a `Database` of `@aws-blocks/bb-data` on the same line of code is a new block with a new cluster. To keep the old cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it. A `Database` that takes the place of a `DistributedDatabase` with the same id keeps its cluster.
  - **`@aws-cdk-blocks/create-blocks-app`:** the `sql` and `demo` templates use the new `Database` on its default Aurora DSQL cluster, with migrations in `cdk-blocks/migrations/<id>/`. The templates' `cdk.json` has no `@aws-blocks/bb-data:encryptStorageByDefault` context key.
  - **`@aws-cdk-blocks/bb-database`:** the CDK `Database` records itself as the `Database` Building Block of the stack.

  **An existing PostgreSQL database.** `DatabaseCluster.fromExisting({ name, ca })` puts a `Database` on a PostgreSQL database that already exists, with its tables and data; Supabase is the tested provider. The block provisions nothing and `db.cluster.kind` is `'external'`. The connection string is never written in code: with `name` the block reads the SSM SecureString `/<stackName>-<name>` on AWS and a local value under `.bb-data/`, and `connectionString` takes your own `AppSetting` or `Secret`. The server certificate is always verified, against `ca` (PEM text) or Node's trust store, and a connection string that carries a TLS parameter is refused. Local mode connects to the real database and runs no migration file.

  Migrations on an existing database run during the deploy, in a function outside any VPC, one transaction per file; the file is recorded in that transaction. The `_migrations` table and the files of an app that used `@aws-blocks/bb-data` with `fromExisting()` continue as they are, so no file runs twice.

  **`npm run db`** runs the commands of `@aws-cdk-blocks/bb-database`. `pull` and `generate-types` are not commands any more.

  - `connect` checks an existing database (certificate, role, policies, endpoint) and stores the connection string for local mode or for a stage. The connection string is read from a hidden prompt or stdin and is never printed.
  - `migrate` applies pending files to the development database with the code a deploy uses. `migrate --mark-applied <file>` records a file as applied without running it, for a schema dump of a database that already has the schema; `--stage` records it on a stage.
  - `types` writes one `Tables` interface for Kysely. `status` lists applied and pending files.
  - `types --block <id>` writes the `Tables` interface of a block that provisions its cluster, from the block's migration files (`cdk-blocks/migrations/<id>`). It applies the files to a new local database in a temporary directory, so it needs no AWS account and does not touch `.bb-data/`. Pass `--type aurora` for a block on an `aurora` cluster.
  - `status --block <id>` lists the applied and the pending files in the block's local database; pass `--cluster <id>` for a block on a `DatabaseCluster`. It reads a copy of the database, so it is safe while `npm run dev` runs.

  On a cluster that the block owns, migrations run on the first statement in local mode and during the deploy on AWS.

  **Statements as a user or a role.** `Database.asUser(user, claims?)` returns the block with every statement run as one user, for tables with Row Level Security on an `aurora` cluster. Each transaction on it starts by setting `request.jwt.claims` to `{ ...claims, sub: user.userId }` for that transaction only, so a policy such as `USING (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub')` gives each user their own rows. `query`, `queryOne`, `execute`, `transaction` and Kysely (`new DatabaseDialect(db.asUser(user))`) all run as the user, locally and on AWS. The result of an auth block's `requireAuth()` passes as it is. A statement on the block itself carries no user and reads no rows from a table whose policy compares with `sub`.

  `Database.asRole(role, claims?)` returns the block with every statement run as a database role, for Row Level Security policies written for a role (`TO authenticated`): each transaction starts with `SET LOCAL ROLE` and the claims, for that transaction only. Use it where the connection role owns the tables, since PostgreSQL does not apply policies to an owner.

  `asUser()` and `asRole()` throw `DatabaseConfigurationError` on a `dsql` cluster. A Kysely transaction's isolation level is now set by the engine, and `BEGIN` is tried once more when its pooled connection was closed while idle.

  **Errors.**

  - A write that a policy refuses fails with the new `DatabaseErrors.PermissionDenied` (HTTP 403).
  - A statement that breaks a constraint now has its own error name: `DatabaseErrors.NotNullViolation` and `DatabaseErrors.CheckViolation` (HTTP 400), and `DatabaseErrors.ForeignKeyViolation` (HTTP 409). These were `QueryFailed` before. The message has no value of the row; the server's own text stays on the server-side `cause`. None of the three is retried.
  - `ConnectionFailed` now also covers a connection that was never made (the address did not answer, the server certificate was not accepted, the login was refused); these were `QueryFailed` before. A connection that ends between two statements of a transaction no longer ends the Node process, and a connect that timed out is no longer tried a second time.

  **Local mode.** A block's statements run as a plain database role with the grants the deployed app role gets; migrations run as the admin. PostgreSQL now refuses the same statements under `npm run dev` as on AWS: DDL and `TRUNCATE` outside a migration, and reads of the migration ledger, fail with `QueryFailed`. A Row Level Security policy on a table of an `aurora` cluster applies to the block's statements locally as it does on AWS. DDL in a handler was `DatabasePermissionException` locally before; the `_migrations` and `_migration_progress` tables are no longer readable from application code. An existing `.bb-data` directory needs no reset.

  **`@aws-cdk-blocks/core`.** `npm run dev`, `sandbox` and `deploy` do not apply migrations to an external database before they run. `sandbox` and `deploy` no longer copy a `*_DB_URL` or `*_CONNECTION_STRING` environment variable to the SSM parameter `/<stackName>-db-url`. `npm run db -- connect --stage <stage>` stores the connection string of a `Database` on an existing database, after it has checked the database; an environment value written on every deploy replaced what that command stored. A parameter that an earlier deploy wrote stays in SSM and is still read with `DatabaseCluster.fromExisting({ name: 'db-url' })`. `ensureSecrets` is not exported from `@aws-cdk-blocks/core/scripts` and `aws-cdk-blocks/scripts` any more.

- 703238f: refactor: rename the scaffolded backend folder to `cdk-blocks`

  `create-blocks-app` now scaffolds the backend into `cdk-blocks/`, the folder's own package is named `cdk-blocks`, the parent lists it under `"workspaces"`, and the frontend imports it as `cdk-blocks`.

  `@aws-cdk-blocks/bb-database` moves its default migrations root with the folder: `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`, and `db pull` writes `cdk-blocks/database.types.ts` by default. An app that keeps an `aws-blocks/migrations` directory finds no migrations after upgrading, so rename the directory or set an explicit migrations path.

  **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.** An existing app renames the directory, the `"workspaces"` entry that names it, the `"name"` in its `cdk-blocks/package.json`, and every `from 'aws-blocks'` import. There is no dual-name support and no compatibility shim.

  The reserved URL namespace (`/aws-blocks/api`, `/aws-blocks/auth/*`, `/aws-blocks/dashboard`) keeps its path, so deployed API Gateway routes and OAuth callback URLs already registered with an identity provider keep working.

### Patch Changes

- cd533c0: `Database.transaction(fn, { retryOnConflict: true })` now waits before each re-run of the callback, and the default `maxRetries` is 8 instead of 3. The wait is a random time between 0 and a ceiling. The ceiling is 50 ms for the first retry, doubles with each retry and stops at 2,000 ms. Before, the retries ran with no wait, so transactions that conflicted on one row re-ran together and conflicted again. Measured on 2026-11-15 against real clusters in us-east-1, with 10 concurrent read-modify-write transactions on one row of a `dsql` cluster: 52% still failed with `SerializationFailure` after 3 retries with no wait, and 0 of 425 failed with the new wait and default, with up to 50 concurrent writers.

  With the default, the waits add up to 7.15 seconds at most; pass a smaller `maxRetries` when the caller cannot wait that long. An explicit `maxRetries` keeps its meaning. Local mode and AWS behave the same. The retries of a single `query` or `execute` outside a transaction are unchanged.

  `transaction()` has a new option, `signal`. When the signal is aborted, the block does not wait or re-run the callback again. Pass `context.request.signal` in an API method so that a retry cannot commit after the request deadline. A `maxRetries` that is not a whole number of 0 or more now throws `DatabaseConfigurationError`; before, such a value turned the retries off without a message.

- 961582d: The Aurora DSQL cluster a `Database` or `DatabaseCluster` creates now carries the tags applied with `Tags.of()`, including the `app=<id>` tag that `defaults.appIdentity` stamps on every resource, in the synthesized template. The cluster keeps its logical id and properties, so an existing cluster is updated in place, not replaced.
- 6d3077e: docs: refer to `KVStore` as the one NoSQL block

  Docstrings, READMEs and design notes that pointed at `DistributedTable` now describe `KVStore` with a `schema` and a `key`. No code changes.

- e1e4844: Run AWS Blocks tasks with your app's package manager. New apps define tasks in `package.json` without generating launcher files or installing the `cdk-blocks` executable. Look up documentation with `npm run docs KVStore`, read the API signatures with `npm run docs:api KVStore`, or search with `npm run docs:search "partition key"`.

  Structured task results print text in a terminal and JSON on a pipe or redirect. Use `npm run -s docs KVStore` for clean JSON without npm's banner, or `npm run -s docs -- KVStore --output text` to pipe Markdown. Scripts that previously invoked `cdk-blocks` must switch to package tasks; scripts calling the programmatic `aws-cdk-blocks/scripts` entry remain supported.

  If your app's scripts call `cdk-blocks`, upgrade `aws-cdk-blocks` first. From the app directory, preview the migration without relying on the removed executable:

  ```sh
  node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run
  ```

  Review the plan, then run the same command without `--dry-run` from a clean Git working tree. The migration rewrites recognized generated scripts and reports custom wrappers that need manual changes.

- 58817b0: fix(core): add aws:SourceAccount/aws:SourceArn conditions to service-principal trust policies; add synth-time check

  The IAM roles AWS Blocks creates for a backend now scope every service-principal trust to the stack's account:

  - The `KnowledgeBase` Bedrock service role adds `aws:SourceArn` matching `arn:<partition>:bedrock:<region>:<account>:knowledge-base/*` beside its existing `aws:SourceAccount` condition.
  - The waiter state machine roles of the `KVStore` index provider and the `Database` migration provider trust `states.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:states:<region>:<account>:stateMachine:*`.
  - The `ContainerCompute` task execution role trusts `ecs-tasks.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:ecs:<region>:<account>:*`, the same scope as its task-role trust.
  - The `Auth` SMS role (created for phone sign-in or SMS MFA) trusts `cognito-idp.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:cognito-idp:<region>:<account>:userpool/*`, beside the `sts:ExternalId` it already had.
  - The `@aws-cdk-blocks/hosting` API Gateway REST door no longer creates CDK's per-API CloudWatch role and `AWS::ApiGateway::Account` setting; its stage configures no logging.

  Synth now checks the roles AWS Blocks covers for a backend for a service-principal trust with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition. That is the same set of roles `defaults.permissionsBoundary` applies to: for a `BlocksStack` the whole stack, for an embedded `BlocksBackend` its subtree and the stack-level roles created on its behalf. Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`) are accepted as they are, as is the `apigateway.amazonaws.com` trust of an API Gateway CloudWatch Logs role: any role an `AWS::ApiGateway::Account` in the same stack names as its `cloudWatchRoleArn`, such as `BlocksApiGatewayCloudWatchRole` (created by `@aws-cdk-blocks/core` and `@aws-cdk-blocks/hosting` when access logging is on) or the default `cloudWatchRole` of a CDK `RestApi` the app adds. That trust stays unconditioned: API Gateway does not send `aws:SourceAccount` or `aws:SourceArn` when it delivers logs with this role, so a condition stops log delivery.

  - A role AWS Blocks creates (under an AWS Blocks Building Block or a compute, or at stack scope on a block's behalf) fails synth; the error names the role's construct path and the principal.
  - A role the app creates gets a synth warning instead, and synth succeeds: one its backend module adds (on a `BlocksStack` or an embedded `BlocksBackend`, at stack scope, under a `Scope` namespace, or inside a custom block the app writes as a `Scope` subclass), one added to a `BlocksStack` after `create()`, and one a CDK construct creates inside any of these (for example the `EventsRole` of an `events.Rule` targeting a state machine).

  Ownership follows who created the role: AWS Blocks' own blocks, computes and stack-level helpers mark the constructs they create, and every other covered role is the app's.

  To resolve the warning, add both conditions to the role's trust statement. For a role a CDK construct creates with no prop for its trust, set them with `role.node.defaultChild.addPropertyOverride('AssumeRolePolicyDocument.Statement.N.Condition', { ... })`; the warning names `N`. To keep the trust as it is, acknowledge the warning with `Annotations.of(role).acknowledgeWarning('@aws-cdk-blocks/core:serviceRoleTrustWithoutSourceCondition')`, or on the stack for every role in it. See "Service-principal trust" in the `@aws-cdk-blocks/core` README.

- Updated dependencies [d01c34c]
- Updated dependencies [e83d152]
- Updated dependencies [c6a3357]
- Updated dependencies [5f55dac]
- Updated dependencies [75c5d98]
- Updated dependencies [5f55dac]
- Updated dependencies [2eb62fa]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [c67048e]
- Updated dependencies [b2eb306]
- Updated dependencies [703238f]
- Updated dependencies [45a05d1]
- Updated dependencies [1de6ea4]
- Updated dependencies [aaf419f]
- Updated dependencies [5938d8b]
- Updated dependencies [a5e754b]
- Updated dependencies [f133ff8]
- Updated dependencies [9ebf67a]
- Updated dependencies [76fd75c]
- Updated dependencies [3ae8592]
- Updated dependencies [e5822ed]
- Updated dependencies [3ae8592]
- Updated dependencies [9059918]
- Updated dependencies [5f55dac]
- Updated dependencies [4665f81]
- Updated dependencies [1deb34b]
- Updated dependencies [c1fabce]
- Updated dependencies [d46dfaf]
- Updated dependencies [41968b7]
- Updated dependencies [8894669]
- Updated dependencies [b2eb306]
- Updated dependencies [0cf1aa2]
- Updated dependencies [15e65b4]
- Updated dependencies [d46dfaf]
- Updated dependencies [5f55dac]
- Updated dependencies [d46dfaf]
- Updated dependencies [c1fabce]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [81113a3]
- Updated dependencies [c045273]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [369b175]
- Updated dependencies [d7f62f3]
- Updated dependencies [3be61fa]
- Updated dependencies [36888a1]
- Updated dependencies [fcf087d]
- Updated dependencies [2c9005f]
- Updated dependencies [384827f]
- Updated dependencies [58daa51]
- Updated dependencies [6151940]
- Updated dependencies [b7c262c]
- Updated dependencies [73feb71]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [d46dfaf]
- Updated dependencies [ebfe2ed]
- Updated dependencies [99660fd]
- Updated dependencies [c1fabce]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [cd533c0]
- Updated dependencies [44c7377]
- Updated dependencies [1ec956f]
- Updated dependencies [c1fabce]
- Updated dependencies [4d81f11]
- Updated dependencies [072c3ff]
- Updated dependencies [c67048e]
- Updated dependencies [5f55dac]
- Updated dependencies [227a856]
- Updated dependencies [afad513]
- Updated dependencies [ba80bbd]
- Updated dependencies [05a88e1]
- Updated dependencies [f32185c]
- Updated dependencies [f32185c]
- Updated dependencies [9801a5b]
- Updated dependencies [a86bccb]
- Updated dependencies [b2eb306]
- Updated dependencies [df25d97]
- Updated dependencies [201e59e]
- Updated dependencies [5f55dac]
- Updated dependencies [a5f39c3]
- Updated dependencies [d01c34c]
- Updated dependencies [5f55dac]
- Updated dependencies [0ff1e1f]
- Updated dependencies [0ff1e1f]
- Updated dependencies [0ff1e1f]
- Updated dependencies [d01c34c]
- Updated dependencies [f7e28b4]
- Updated dependencies [93d533a]
- Updated dependencies [adb6077]
- Updated dependencies [60360c1]
- Updated dependencies [dd1c554]
- Updated dependencies [8ece10a]
- Updated dependencies [c607deb]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [6d3077e]
- Updated dependencies [e1e4844]
- Updated dependencies [2095f31]
- Updated dependencies [e50b9e9]
- Updated dependencies [6d3077e]
- Updated dependencies [80ce128]
- Updated dependencies [d354055]
- Updated dependencies [58817b0]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-cdk-blocks/core@1.0.0-rc.0
  - @aws-cdk-blocks/bb-app-setting@1.0.0-rc.0
  - @aws-cdk-blocks/bb-logger@1.0.0-rc.0
