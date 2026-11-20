# @aws-cdk-blocks/bb-database

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since the 0.x releases

- A new package. `Database` replaces `@aws-blocks/bb-data` and `@aws-blocks/bb-distributed-data`.
- 06355de: `DatabaseCluster` gains `type: 'aurora'`: Aurora PostgreSQL Serverless v2 created with the express configuration.
- 7c1eec5: An app that deployed a SQL block of an earlier release keeps its database.
- f45b407: `@aws-cdk-blocks/bb-database/kysely` exports `DatabaseDialect`, a Kysely dialect for a `Database`: `new Kysely<Tables>({ dialect: new DatabaseDialect(db) })`.
- 4e41c28: Adds `Database`, a SQL block on an Aurora DSQL or Aurora PostgreSQL cluster.
- c67048e: `Database` is the only SQL block. `@aws-blocks/bb-data` and `@aws-blocks/bb-distributed-data` are removed. See "Upgrade from `@aws-blocks/bb-data`" in the `bb-database` README.
- c42ba42: The hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.
- 703238f: The scaffolded backend folder is `cdk-blocks/` instead of `aws-blocks/`.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The errors table in the docs gives the `error.name` a caller sees, `QueryFailedException` and not `QueryFailed`. The README has a table of the `transaction()` options.

## 1.0.0-rc.1

### Minor Changes

- c42ba42: **Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

  To upgrade:

  1. Run `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`, then delete the empty `.blocks/` folder.
  2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`.
  3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

  Local data is copied to the new location the first time each block opens its store. Pull request #1607 has the full notes.

### Patch Changes

- e529b00: `asRole()` works after the first deploy of a cluster that `Database` provisions, and a migration can grant a role to the app role. Write the app role as `${app_role}`, for example `GRANT authenticated TO ${app_role} WITH INHERIT FALSE, SET TRUE;`.
- e529b00: A migration on a local `aurora` cluster can run `CREATE EXTENSION` for the contrib extensions that PGlite ships and Aurora PostgreSQL supports, such as `citext`, `pgcrypto`, and `pg_trgm`. An extension that PGlite does not ship, such as `vector`, still fails locally.
- c9d73a8: The `KVStore` and `Database` README examples import from `aws-cdk-blocks`, so a copied example compiles in a scaffolded app. Import the `/kysely` and `/testing` entry points from `@aws-cdk-blocks/bb-database` as before.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: **Breaking: every published package moves from the `@aws-blocks` scope to `@aws-cdk-blocks`, and `@aws-blocks/blocks` becomes the unscoped `aws-cdk-blocks`.**

  To upgrade:

  1. In `package.json`, replace `@aws-blocks/blocks` with `aws-cdk-blocks` and every other `@aws-blocks/` name with `@aws-cdk-blocks/`, for example `@aws-cdk-blocks/core`.
  2. Make the same replacement in the specifier of every import.
  3. Change each `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the `@aws-cdk-blocks/` prefix, or `cdk synth --strict` fails on the warning.
  4. Keep the CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` in `cdk.json` as it is, because renaming it makes CloudFormation replace the cluster.
  5. If you publish a block, move its dependency from `@aws-blocks/core` to `@aws-cdk-blocks/core`.

  No export or option moved, and the old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- 06355de: Adds `type: 'aurora'` to `DatabaseCluster`, an Aurora PostgreSQL Serverless v2 cluster that runs outside a VPC, scales to zero, and uses IAM authentication only. Renames `DsqlDatabaseOptions` to `SharedDatabaseOptions`, and a rejected migration file throws `MigrationValidationError` for both kinds.
- 7c1eec5: An app that deployed `DistributedDatabase` or the `@aws-blocks/bb-data` `Database` keeps its database, and `docs/guides/upgrading-older-apps.md` has the steps. Adds `DatabaseCluster.fromExisting({ dataApi: { clusterArn, secretArn, database } })` for an Aurora cluster through the RDS Data API.
- f45b407: Adds `@aws-cdk-blocks/bb-database/kysely`, which exports `DatabaseDialect`, a Kysely dialect for a `Database`. Install Kysely in your app, run every statement inside a Kysely transaction on `trx`, and note that streaming is not supported.
- 4e41c28: Adds `@aws-cdk-blocks/bb-database`, a preview `Database` block on Aurora DSQL that `aws-cdk-blocks` does not re-export yet. A renamed `Database` or `DatabaseCluster` id keeps the old cluster and its data, but points the app at a new, empty one.

- c67048e: **Breaking: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block, and `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data`, and `@aws-blocks/data-common` are removed.**

  To upgrade:

  1. Import `Database`, `DatabaseCluster`, `DatabaseErrors`, and `sql` from `aws-cdk-blocks`.
  2. To keep an old `@aws-blocks/bb-data` cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it.
  3. Replace `DistributedDatabase` with a `Database` of the same id, which keeps its cluster.
  4. Replace `Database.fromExisting()` with `DatabaseCluster.fromExisting()`, passed as `cluster`.
  5. Replace `withRLS()` with `asUser()` or `asRole()`, and use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely` for Kysely.
  6. Store the connection string of an existing database with `npm run db -- connect --stage <stage>`, not a `*_DB_URL` or `*_CONNECTION_STRING` environment variable.

  Data is not moved, and `crud()`, `ensureSecrets`, and the `npm run db` commands `pull` and `generate-types` are removed.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

### Patch Changes

- cd533c0: `Database.transaction(fn, { retryOnConflict: true })` waits before each retry, and the default `maxRetries` is 8 instead of 3, with waits of up to 7.15 seconds in total. Adds a `signal` option to `transaction()` that stops the retries when the signal is aborted.
- 961582d: The Aurora DSQL cluster a `Database` or `DatabaseCluster` creates carries the tags applied with `Tags.of()`, including the `app=<id>` tag from `defaults.appIdentity`. An existing cluster is updated in place, not replaced.
- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.

- e1e4844: **Breaking: the `cdk-blocks` executable is removed, and AWS Blocks tasks run through your app's package manager.**

  To upgrade:

  1. Upgrade `aws-cdk-blocks`.
  2. From the app directory, run `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run` and review the plan.
  3. Run the same command without `--dry-run` from a clean Git working tree.
  4. Change by hand the custom wrappers that the migration reports.

  Structured tasks such as `npm run docs KVStore`, `npm run docs:api KVStore`, and `npm run docs:search "partition key"` print text in a terminal and JSON on a pipe or redirect.

- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.
