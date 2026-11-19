---
"aws-cdk-blocks": minor
"@aws-cdk-blocks/bb-database": minor
"@aws-cdk-blocks/core": minor
"@aws-cdk-blocks/create-blocks-app": minor
"@aws-cdk-blocks/bb-app-setting": patch
"@aws-cdk-blocks/bb-auth": patch
"@aws-cdk-blocks/bb-file-bucket": patch
"@aws-cdk-blocks/admin-ui": patch
---

feat!: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block

**Breaking change.** `aws-cdk-blocks` exports `Database`, `DatabaseCluster`, `DatabaseErrors` and `sql` from `@aws-cdk-blocks/bb-database`. The packages `@aws-cdk-blocks/bb-data`, `@aws-cdk-blocks/bb-distributed-data` and `@aws-cdk-blocks/data-common` are not part of AWS Blocks any more. There is no compatibility layer.

```ts
import { Database, DatabaseCluster, sql } from 'aws-cdk-blocks';

const orders = new Database(scope, 'orders'); // owns an Aurora DSQL cluster

const cluster = new DatabaseCluster(scope, 'main', { type: 'aurora' }); // Aurora PostgreSQL Serverless v2
const users = new Database(scope, 'users', { cluster });
```

- **`Database`** owns an Aurora DSQL cluster when it has no `cluster` option. A `DatabaseCluster` of type `'dsql'` or `'aurora'` holds several `Database` blocks, each in its own schema. Migrations are ordered `.sql` files in `cdk-blocks/migrations/<id>/`.
- **Not exported any more:** `DistributedDatabase`, `DistributedDatabaseErrors`, `DistributedDatabaseOptions`, `Database.fromExisting()` and `ExternalDatabaseRef` (an existing PostgreSQL database is now `DatabaseCluster.fromExisting()`, passed as `cluster`). `withRLS()` is replaced by `asUser()` and `asRole()`. `crud()` has no equivalent in `@aws-cdk-blocks/bb-database`. For Kysely, use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely`.
- **`getSdkIdentifiers(db)`** returns `clusterId` and `schemaName`, plus `clusterEndpoint` and `region` in a deployed Lambda. `getSdkIdentifiers(cluster)` returns `clusterEndpoint`.
- **Data is not moved.** A `Database` that takes the place of a `Database` of `@aws-cdk-blocks/bb-data` on the same line of code is a new block with a new cluster. To keep the old cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it. A `Database` that takes the place of a `DistributedDatabase` with the same id keeps its cluster.
- **`@aws-cdk-blocks/create-blocks-app`:** the `sql` and `demo` templates use the new `Database` on its default Aurora DSQL cluster, with migrations in `cdk-blocks/migrations/<id>/`. The templates' `cdk.json` has no `@aws-cdk-blocks/bb-data:encryptStorageByDefault` context key.
- **`@aws-cdk-blocks/bb-database`:** the CDK `Database` records itself as the `Database` Building Block of the stack.

**An existing PostgreSQL database.** `DatabaseCluster.fromExisting({ name, ca })` puts a `Database` on a PostgreSQL database that already exists, with its tables and data; Supabase is the tested provider. The block provisions nothing and `db.cluster.kind` is `'external'`. The connection string is never written in code: with `name` the block reads the SSM SecureString `/<stackName>-<name>` on AWS and a local value under `.bb-data/`, and `connectionString` takes your own `AppSetting` or `Secret`. The server certificate is always verified, against `ca` (PEM text) or Node's trust store, and a connection string that carries a TLS parameter is refused. Local mode connects to the real database and runs no migration file.

Migrations on an existing database run during the deploy, in a function outside any VPC, one transaction per file; the file is recorded in that transaction. The `_migrations` table and the files of an app that used `@aws-cdk-blocks/bb-data` with `fromExisting()` continue as they are, so no file runs twice.

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
