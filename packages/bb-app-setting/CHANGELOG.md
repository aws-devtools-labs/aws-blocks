# @aws-blocks/bb-app-setting

## 1.0.0

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

### Patch Changes

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.
- e83d152: `AppSetting.get()` on AWS now throws `AppSettingErrors.ParameterNotFound` when the SSM parameter does not exist, as documented, instead of the raw SDK `ParameterNotFound` exception.
- c6a3357: `AppSetting.put()` on AWS now enforces the documented 4 KB limit before writing, the same way the local mock does: a non-secret value whose JSON serialization exceeds 4096 UTF-8 bytes throws `AppSettingErrors.ValidationFailed` and is not sent to SSM. Previously the AWS path sent every value to SSM, so a value the mock rejects with `ValidationFailed` was left to SSM's own limit check on AWS, which fails with an unnamed SDK exception. Both paths now share one check, called after schema validation.
- 5f55dac: `AppSetting`'s CDK construct now exposes two read-only properties at synth time: `parameterName`, the SSM parameter name the setting resolves to (the explicit `name`, the `AppSetting.fromExisting()` name, or the derived default `/<fullId>`), and `secret`, whether the parameter is a SecureString. Other Building Blocks' CDK layers can now reference the exact parameter instead of assuming the default name, so a secret created with a custom `name` or via `fromExisting()` can be passed where a Building Block needs a secret. The local and Lambda runtime APIs are unchanged.
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

  **An existing PostgreSQL database.** `DatabaseCluster.fromExisting({ name, ca })` puts a `Database` on a PostgreSQL database that already exists, with its tables and data; Supabase is the tested provider. The block provisions nothing and `db.cluster.kind` is `'external'`. The connection string is never written in code: with `name` the block reads the SSM SecureString `/<stackName>-<name>` on AWS and a local value under `.cdk-blocks/local/data/`, and `connectionString` takes your own `AppSetting` or `Secret`. The server certificate is always verified, against `ca` (PEM text) or Node's trust store, and a connection string that carries a TLS parameter is refused. Local mode connects to the real database and runs no migration file.

  Migrations on an existing database run during the deploy, in a function outside any VPC, one transaction per file; the file is recorded in that transaction. The `_migrations` table and the files of an app that used `@aws-blocks/bb-data` with `fromExisting()` continue as they are, so no file runs twice.

  **`npm run db`** runs the commands of `@aws-cdk-blocks/bb-database`. `pull` and `generate-types` are not commands any more.

  - `connect` checks an existing database (certificate, role, policies, endpoint) and stores the connection string for local mode or for a stage. The connection string is read from a hidden prompt or stdin and is never printed.
  - `migrate` applies pending files to the development database with the code a deploy uses. `migrate --mark-applied <file>` records a file as applied without running it, for a schema dump of a database that already has the schema; `--stage` records it on a stage.
  - `types` writes one `Tables` interface for Kysely. `status` lists applied and pending files.
  - `types --block <id>` writes the `Tables` interface of a block that provisions its cluster, from the block's migration files (`cdk-blocks/migrations/<id>`). It applies the files to a new local database in a temporary directory, so it needs no AWS account and does not touch `.cdk-blocks/local/data/`. Pass `--type aurora` for a block on an `aurora` cluster.
  - `status --block <id>` lists the applied and the pending files in the block's local database; pass `--cluster <id>` for a block on a `DatabaseCluster`. It reads a copy of the database, so it is safe while `npm run dev` runs.

  On a cluster that the block owns, migrations run on the first statement in local mode and during the deploy on AWS.

  **Statements as a user or a role.** `Database.asUser(user, claims?)` returns the block with every statement run as one user, for tables with Row Level Security on an `aurora` cluster. Each transaction on it starts by setting `request.jwt.claims` to `{ ...claims, sub: user.userId }` for that transaction only, so a policy such as `USING (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub')` gives each user their own rows. `query`, `queryOne`, `execute`, `transaction` and Kysely (`new DatabaseDialect(db.asUser(user))`) all run as the user, locally and on AWS. The result of an auth block's `requireAuth()` passes as it is. A statement on the block itself carries no user and reads no rows from a table whose policy compares with `sub`.

  `Database.asRole(role, claims?)` returns the block with every statement run as a database role, for Row Level Security policies written for a role (`TO authenticated`): each transaction starts with `SET LOCAL ROLE` and the claims, for that transaction only. Use it where the connection role owns the tables, since PostgreSQL does not apply policies to an owner.

  `asUser()` and `asRole()` throw `DatabaseConfigurationError` on a `dsql` cluster. A Kysely transaction's isolation level is now set by the engine, and `BEGIN` is tried once more when its pooled connection was closed while idle.

  **Errors.**

  - A write that a policy refuses fails with the new `DatabaseErrors.PermissionDenied` (HTTP 403).
  - A statement that breaks a constraint now has its own error name: `DatabaseErrors.NotNullViolation` and `DatabaseErrors.CheckViolation` (HTTP 400), and `DatabaseErrors.ForeignKeyViolation` (HTTP 409). These were `QueryFailed` before. The message has no value of the row; the server's own text stays on the server-side `cause`. None of the three is retried.
  - `ConnectionFailed` now also covers a connection that was never made (the address did not answer, the server certificate was not accepted, the login was refused); these were `QueryFailed` before. A connection that ends between two statements of a transaction no longer ends the Node process, and a connect that timed out is no longer tried a second time.

  **Local mode.** A block's statements run as a plain database role with the grants the deployed app role gets; migrations run as the admin. PostgreSQL now refuses the same statements under `npm run dev` as on AWS: DDL and `TRUNCATE` outside a migration, and reads of the migration ledger, fail with `QueryFailed`. A Row Level Security policy on a table of an `aurora` cluster applies to the block's statements locally as it does on AWS. DDL in a handler was `DatabasePermissionException` locally before; the `_migrations` and `_migration_progress` tables are no longer readable from application code. An existing `.cdk-blocks/local/data` directory needs no reset.

  **`@aws-cdk-blocks/core`.** `npm run dev`, `sandbox` and `deploy` do not apply migrations to an external database before they run. `sandbox` and `deploy` no longer copy a `*_DB_URL` or `*_CONNECTION_STRING` environment variable to the SSM parameter `/<stackName>-db-url`. `npm run db -- connect --stage <stage>` stores the connection string of a `Database` on an existing database, after it has checked the database; an environment value written on every deploy replaced what that command stored. A parameter that an earlier deploy wrote stays in SSM and is still read with `DatabaseCluster.fromExisting({ name: 'db-url' })`. `ensureSecrets` is not exported from `@aws-cdk-blocks/core/scripts` and `aws-cdk-blocks/scripts` any more.

- e529b00: docs: the README error examples now import the error constants and `isBlocksError` from `aws-cdk-blocks`, which every scaffolded app depends on. The same import works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`. Existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- 0b422ee: docs: `value` is required unless `secret: true`. `ParameterNotFound` is thrown on AWS only. `get()` parses the stored text as JSON, so a console value such as `12345` comes back as a number. `fromExisting` does not create the parameter or grant write access.
- a5f39c3: docs: KVStore's 409 and local data file, AppSetting's local data file, and RawRoute params locally

  - `KVStore`: a failed condition is status 409 in the JSON-RPC error, and HTTP 409 only with `httpErrorStatus: true`. The Local development section says that the mock reads `store.json` only when it constructs the store, so two processes on one `.cdk-blocks/local/data` folder can write over each other.
  - `AppSetting`: its mock keeps values in the shared `.cdk-blocks/local/data/settings.json`, not `.cdk-blocks/local/data/settings/{fullId}/value.json`.
  - Core: a `RawRoute` fills `params` the same way under `npm run dev` and deployed.

- 5f55dac: Docs and editor hover text now point at `Auth`, the single authentication Building Block, instead of the removed `AuthBasic`, `AuthCognito` and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table comparing email + password, social, OIDC verified by your backend (`store: 'builtin'`), OIDC through Cognito, and SAML by Cognito free tier, offline support and user-pool features. The `hasAuthError` example in `@aws-cdk-blocks/core` now matches `AuthErrors.NotAuthorized`.
- 0ff1e1f: docs: the AppSetting and Secret docs describe the installed version

  The Secret docs no longer promise "(future) managed rotation", which `Secret` does not expose, and the design notes drop "v1" and "unchanged" framing.

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

- Updated dependencies [63e571c]
- Updated dependencies [cad7bb8]
- Updated dependencies [d01c34c]
- Updated dependencies [75c5d98]
- Updated dependencies [5f55dac]
- Updated dependencies [2eb62fa]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [c67048e]
- Updated dependencies [e529b00]
- Updated dependencies [b2eb306]
- Updated dependencies [fbe48c5]
- Updated dependencies [c42ba42]
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
- Updated dependencies [3081521]
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
- Updated dependencies [0b422ee]
- Updated dependencies [d01c34c]
- Updated dependencies [0b422ee]
- Updated dependencies [5f55dac]
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
- Updated dependencies [23692f1]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-cdk-blocks/bb-logger@1.0.0
  - @aws-cdk-blocks/core@1.0.0

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: docs: `value` is required unless `secret: true`. `ParameterNotFound` is thrown on AWS only. `get()` parses the stored text as JSON, so a console value such as `12345` comes back as a number. `fromExisting` does not create the parameter or grant write access.
- Updated dependencies [cad7bb8]
- Updated dependencies [0b422ee]
- Updated dependencies [0b422ee]
  - @aws-cdk-blocks/core@1.0.0-rc.2
  - @aws-cdk-blocks/bb-logger@1.0.0-rc.2

## 1.0.0-rc.1

### Patch Changes

- e529b00: docs: the README error examples now import the error constants and `isBlocksError` from `aws-cdk-blocks`, which every scaffolded app depends on. The same import works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`. Existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- Updated dependencies [e529b00]
- Updated dependencies [fbe48c5]
- Updated dependencies [c42ba42]
- Updated dependencies [3081521]
- Updated dependencies [23692f1]
  - @aws-cdk-blocks/core@1.0.0-rc.1
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

### Patch Changes

- e83d152: `AppSetting.get()` on AWS now throws `AppSettingErrors.ParameterNotFound` when the SSM parameter does not exist, as documented, instead of the raw SDK `ParameterNotFound` exception.
- c6a3357: `AppSetting.put()` on AWS now enforces the documented 4 KB limit before writing, the same way the local mock does: a non-secret value whose JSON serialization exceeds 4096 UTF-8 bytes throws `AppSettingErrors.ValidationFailed` and is not sent to SSM. Previously the AWS path sent every value to SSM, so a value the mock rejects with `ValidationFailed` was left to SSM's own limit check on AWS, which fails with an unnamed SDK exception. Both paths now share one check, called after schema validation.
- 5f55dac: `AppSetting`'s CDK construct now exposes two read-only properties at synth time: `parameterName`, the SSM parameter name the setting resolves to (the explicit `name`, the `AppSetting.fromExisting()` name, or the derived default `/<fullId>`), and `secret`, whether the parameter is a SecureString. Other Building Blocks' CDK layers can now reference the exact parameter instead of assuming the default name, so a secret created with a custom `name` or via `fromExisting()` can be passed where a Building Block needs a secret. The local and Lambda runtime APIs are unchanged.
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

- a5f39c3: docs: KVStore's 409 and local data file, AppSetting's local data file, and RawRoute params locally

  - `KVStore`: a failed condition is status 409 in the JSON-RPC error, and HTTP 409 only with `httpErrorStatus: true`. The Local development section says that the mock reads `store.json` only when it constructs the store, so two processes on one `.bb-data` folder can write over each other.
  - `AppSetting`: its mock keeps values in the shared `.bb-data/settings.json`, not `.bb-data/settings/{fullId}/value.json`.
  - Core: a `RawRoute` fills `params` the same way under `npm run dev` and deployed.

- 5f55dac: Docs and editor hover text now point at `Auth`, the single authentication Building Block, instead of the removed `AuthBasic`, `AuthCognito` and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table comparing email + password, social, OIDC verified by your backend (`store: 'builtin'`), OIDC through Cognito, and SAML by Cognito free tier, offline support and user-pool features. The `hasAuthError` example in `@aws-cdk-blocks/core` now matches `AuthErrors.NotAuthorized`.
- 0ff1e1f: docs: the AppSetting and Secret docs describe the installed version

  The Secret docs no longer promise "(future) managed rotation", which `Secret` does not expose, and the design notes drop "v1" and "unchanged" framing.

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
  - @aws-cdk-blocks/bb-logger@1.0.0-rc.0

## 0.4.0

### Minor Changes

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

### Patch Changes

- 43603b0: Give the secret-init custom-resource Lambda (`BlocksSecretInitFn`) an explicit 2-minute timeout. It previously ran with Lambda's 3-second default, so a slow cold start could fail the `BlocksSecretsBulk` custom resource with "Task timed out after 3.00 seconds" and roll back the deploy of any stack that uses `AppSetting` with `secret: true`.
- 943d405: fix: error constants can be imported in frontend code

  Frontend code imports a Building Block's error constants to match errors with `isBlocksError`, which resolves the
  package's `browser` entry. Some of those imports failed the frontend build:

  - `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors` were missing from the `browser` entries
    of `@aws-blocks/bb-app-setting`, `@aws-blocks/bb-email-client`, `@aws-blocks/bb-file-bucket`, and
    `@aws-blocks/bb-logger`. They are now exported.
  - Any import from `@aws-blocks/bb-auth-basic` or `@aws-blocks/bb-auth-cognito`, including `AuthBasicErrors` and
    `AuthCognitoErrors`, failed with `No matching export ... for import "ApiNamespace"`. The browser stubs no longer
    depend on `ApiNamespace`; their server-only `createApi()` / `buildApi()` now throw if called in the browser.
  - `CronJobErrors.ScheduleNotSupported` was `undefined` in the browser, so `isBlocksError(e, CronJobErrors.ScheduleNotSupported)`
    never matched. The `@aws-blocks/bb-cron-job` and `@aws-blocks/bb-dashboard` browser entries now re-export the
    server's constants instead of keeping their own copies.
  - `@aws-blocks/bb-realtime` had no `browser` entry, so importing `RealtimeErrors` in frontend code pulled in the
    server build and failed to bundle. It now has one.

  `@aws-blocks/blocks`: the conditional-export parity test now checks that every Building Block with error constants
  has a `browser` entry that exports them with the same values, and that the entry bundles for the browser.

- a3969b5: fix: actionable errors for runtime methods called during `cdk synth`

  Calling a Building Block's runtime method (for example `db.query()`, `bucket.put()`, `auth.requireAuth()`, or
  `auth.admin`) at the top level of a backend module runs it during `cdk synth`. For many Building Blocks this failed with
  a cryptic `TypeError: x is not a function`; it now throws the same actionable error the other Building Blocks already
  give: `<Class>.<method>() cannot be called during CDK synth. Data methods run at request time — …`.

- 48c35f6: fix: export the same names from every conditional entry point

  Some Building Blocks were missing named exports from their `cdk` or `browser`
  entry points, even though the TypeScript types said they were there. Importing
  one of these names from code evaluated during `cdk synth`, or from a browser
  bundle, failed at import time. Added:

  - `cdk` entry: `InterruptError` (`@aws-blocks/bb-agent`), `BatchSubmitFailedError`
    (`@aws-blocks/bb-async-job`), and `RLSEnabledDatabase` and `PgClientEngine`
    (`@aws-blocks/bb-data`).
  - `browser` entry: the error constants `AgentErrors`, `AppSettingErrors`,
    `EmailErrors`, `FileBucketErrors` and `LoggingErrors` (for `isBlocksError` checks
    in frontend code), plus `InterruptError`, `BedrockModels` and `OllamaModels`
    (`@aws-blocks/bb-agent`) and `fromExisting` (`@aws-blocks/bb-data`).

  The conditional-exports regression test now compares every Building Block's
  `aws-runtime`, `cdk` and `browser` entries against its default entry in both
  directions, so these gaps can't come back unnoticed.

- 48c35f6: Two Building Blocks that would handle the same Lambda event now fail `cdk synth`, instead of deploying and then failing every request on cold start. This covers two `AsyncJob`s whose queue names collide, and two `CronJob`s or `Realtime` blocks that end up with the same scope-qualified id (for example `x-y`/`z` and `x`/`y-z`). The error names the event key and both blocks.

  `registerConfig()` now also fails synth when another construct has already registered the same config key for the same backend with a different value, naming the key and both constructs; before, the second value silently replaced the first and both blocks read the same resource at runtime. Config keys built from a block id fold case and map every non-alphanumeric character to `_`, so ids such as `orders-a` and `orders_a` (or `Orders` and `orders`) collided this way: rename one of the blocks. Registering a key again from the same construct, or with the same value, is unaffected. Keys shared by design keep their last-one-wins behaviour: `Hosting`'s `BLOCKS_PUBLIC_ORIGIN` / `CORS_HOSTING_ORIGINS`, the dashboard URL, and `AppSetting`'s `BLOCKS_SSM_PARAM_*` key.

- d366907: chore: manual dependency bump (2026-10-19)
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [943d405]
- Updated dependencies [50b8c94]
- Updated dependencies [a3969b5]
- Updated dependencies [48c35f6]
- Updated dependencies [ce5dfa9]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [9a32674]
- Updated dependencies [48c35f6]
- Updated dependencies [8c73a24]
- Updated dependencies [48c35f6]
- Updated dependencies [4553866]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [54e9443]
- Updated dependencies [48c35f6]
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [9c96135]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [515089c]
- Updated dependencies [dde6340]
- Updated dependencies [7477b6e]
- Updated dependencies [d79a0bd]
- Updated dependencies [d79a0bd]
- Updated dependencies [6a53068]
- Updated dependencies [dd5e807]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [d79a0bd]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [48c35f6]
  - @aws-blocks/core@0.8.0
  - @aws-blocks/bb-logger@0.3.0

## 0.3.2

### Patch Changes

- 92fa27b: Internal: route named-error minting through `@aws-blocks/core`'s `blocksError`. No behavior change.
- 66f4be2: BREAKING: remove `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler`.

  These returned the default compute's Lambda function, so anything wired through them reached only that one function — not every compute an app runs on. Use the stack-wide equivalents instead, which reach every compute:

  | Before                                              | After                                                                                                                                         |
  | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | `blocksStack.handler.addEnvironment('KEY', value)`  | `registerConfig(blocksStack, 'KEY', value)` — loaded into `process.env` on every compute at cold start, before the backend module is imported |
  | `resource.grantRead(blocksStack.handler)`           | `resource.grantRead(blocksStack.executionRole)`                                                                                               |
  | `blocksStack.handler.addToRolePolicy(statement)`    | `blocksStack.executionRole.addToPrincipalPolicy(statement)`                                                                                   |
  | `this.handler` inside a custom Building Block       | `this.executionRole` / `registerConfig(this, …)`                                                                                              |
  | `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` | `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`                                                                            |

  `registerConfig` and `executionRole` are exported from `@aws-blocks/blocks/cdk` (and `@aws-blocks/core/cdk`).

  **Precedence differs from `addEnvironment`.** `addEnvironment` wrote a real Lambda environment variable, so the last call won. `registerConfig` entries are loaded at cold start only into keys that aren't already set, so a real environment variable of the same name always wins — for example one the framework sets itself (`NODE_ENV`, `BLOCKS_STACK_NAME`) or one set on the function outside CDK. When that happens with a different value, the compute now logs a warning at cold start naming the ignored keys (names only, never values).

  `registerConfig` can be called from app code after `BlocksStack.create()` / `BlocksBackend.create()` resolves. This already worked for every stack, because the framework always registers config of its own; finalize now creates the config deployment unconditionally, so it no longer depends on that.

- ec7eebe: docs: recommend `Secret` for production secrets; position `AppSetting(secret: true)` as a free fallback

  Aligns the Secret ↔ AppSetting guidance with AWS's recommendation that credentials belong in a dedicated secret store. Customer- and agent-facing docs (READMEs, exported-symbol JSDoc) now steer users to `Secret` for any credential protecting a production app and describe `AppSetting` with `secret: true` as a free, encrypted fallback for a low-value secret only — phrased in Blocks terms (`Secret` / `AppSetting`) with a link out to the AWS guidance rather than naming the underlying services inline. The per-BB `DESIGN.md` docs carry the explicit service-level rationale (AWS Secrets Manager vs SSM Parameter Store SecureString).

  Also corrects an inaccurate security tip in the umbrella README that said to "never use `.env` files" — the framework documents legitimate `.env` usage for local dev (e.g. hosting, `bb-data`). The tip now says what it means: don't hardcode secret values in source, and don't ship real secrets to a deployed app through plaintext environment variables — set them through `Secret`/`AppSetting`.

- Updated dependencies [ec7eebe]
- Updated dependencies [e682ba7]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8a1a4a9]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [b8649dc]
- Updated dependencies [2da2fd4]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [7c19c4f]
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-logger@0.2.2

## 0.3.1

### Patch Changes

- 0e18d5b: Validate AppSetting option combinations in local mock, matching CDK synth (#577)

  The CDK constructor rejected several invalid option combinations at synth time (`secret` + `schema`, a `schema` with no `value`, `kmsKeyArn` without `secret: true`, an empty `kmsKeyArn`, a `secret` carrying a `value`, an `external` setting with a `value` or without a `name`, and a non-secret with no `value`), but the local mock had none of these checks. `npm run dev` stayed green on config that later failed at `ampx sandbox` or deploy, and a non-secret with no value silently became an empty string.

  The synchronous option-combination checks now live in a shared `validateAppSettingOptions()` (`src/validation.ts`, following the `bb-metrics` / `bb-distributed-data` pattern) that both the CDK and mock constructors call, so local dev fails fast with the same `ValidationFailedException`. Async Standard Schema value validation stays in each variant's `put()` path.

  Behavior change for local dev: the mock now rejects these combinations instead of accepting them. Any config that relied on the old lax behavior (most notably a non-secret setting declared with no `value`) will now throw locally, as it always would have at synth.

- 757d4a9: feat(core): forward the native client user-agent into the AWS SDK user agent

  Native runtimes send `x-blocks-user-agent: aws-blocks-<lang>/<version>` on the RPC
  request. `@aws-blocks/core` validates it against a strict grammar (length-capped,
  dropped silently when malformed), carries it per request in an `AsyncLocalStorage`,
  and exports `installClientUserAgent`, an SDK middleware that appends the validated
  token to the outgoing user agent. The 12 participating Building Blocks install it,
  so native attribution rides the SDK user-agent chain AWS service telemetry already
  counts. The Kotlin runtime already sends the header, so Kotlin
  callers are attributed as soon as this ships; Swift and Dart follow.

- a23b8d8: Stop leaking raw backend exception details in RPC error responses, while forwarding Building Block error names AND their BB-authored messages.

  `errorResponseFromCatch` sorts a caught throw into three cases: an `ApiError` crosses the wire verbatim (status, `message`, `name`, `retriable`); a Building Block error carrying the wire-safe brand forwards BOTH its BB `name` in `data.name` AND its BB-authored `message` (per D-003, the wire carries `name` alongside `message`), so `isBlocksError()` keeps matching on the client and the caller sees the real, actionable message ("Batch contains 150 payloads, exceeds the 100 limit"); and everything else — a driver/SDK exception, a bare `Error`, or a non-`Error` throw — collapses to a nameless generic `500` / `"Internal error"`. The full error (including `cause`) is still logged server-side in every case.

  The brand is a non-enumerable symbol stamped by core's new `brandBlocksError()` helper, and the serializer keys the name-and-message-forwarding decision on that brand rather than on `.name !== 'Error'`. Every Building Block that mints a named error now routes it through that one helper — core's `blocksError()`, each package's own local `blocksError()`, and the inline named-error sites across the runtime and mock layers — so a BB error keeps its `name` and message on the wire no matter which package or layer threw it. A raw driver exception whose class name happens to be non-generic (`PostgresError`, `DynamoDBServiceException`) is never branded, so neither its class name nor its raw message ever reaches the client.

  The load-bearing invariant, now that messages cross the wire: **a branded error's message must never embed raw driver/SDK text.** Two message-embedding sites are therefore given stable, BB-authored messages (`bb-kv-store` and `bb-distributed-table`'s item-too-large remaps, which previously copied DynamoDB's raw `err.message`), keeping the raw driver error only as `cause`.

  Re-tag paths are branded, with a stable message. The catch-all re-tag paths in `bb-data` (`wrapError` / `translatePgError`) and `bb-distributed-data` (`translateDsqlError`) — which classify a caught driver error as `QueryFailed` / `ConnectionFailed` — now build a fresh BRANDED error carrying the BB `name` and a stable BB message (e.g. "The database query failed"), keeping the raw driver error as `cause`. This preserves the client-side `isBlocksError(e, DatabaseErrors.QueryFailed | .ConnectionFailed)` retry contract the `bb-data` README teaches for auto-pause-resume, and — because the message is a stable BB string, not the driver's — a re-tagged error still never leaks driver internals over the wire. The 40001 / 23505 conflict paths already crossed as `ApiError` (409) with stable messages and are unchanged. Also branded in this pass: `bb-auth-oidc`'s `InvalidRelayError` (a class-field error not reached by the `.name =` sweep) and `bb-distributed-data`'s mock DDL-guard error (name `DsqlPermissionException`, the internal `DSQL_PERMISSION_ERROR_NAME`; now branded with a stable message, its name kept internal and mock-only, not a public `DistributedDatabaseErrors` constant).

  The two `bb-realtime` client-middleware `brandBlocksError` calls are commented as intentionally inert (a client-side subscription rejection matches on `err.name`, never routes through the server serializer). The realtime e2e's `ConnectionFailedException` assertions run against `channel.subscribe()` in-process on the client, not across the RPC serializer.

  ## Breaking change (why `@aws-blocks/core` is a minor)

  App code that throws a plain `Error('Todo not found')` from an API method now surfaces as a generic `500` / `"Internal error"` on the client instead of the raw message (a customer-defined `Error` also loses its `.name`). This is the intended safety net — an unbranded throw is treated as an unhandled internal error — but it changes client-visible behavior, so `@aws-blocks/core` ships as a minor (we are pre-1.0). To send a specific status, name, and message to the client, throw an `ApiError`:

  ```ts
  // before — message collapses to "Internal error" on the client
  throw new Error("Todo not found");

  // after — status, message, and name all reach the client
  throw new ApiError("Todo not found", 404, { name: "TodoNotFoundException" });
  ```

  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.

- Updated dependencies [5501cb6]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [5515483]
- Updated dependencies [757d4a9]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-logger@0.2.1

## 0.3.0

### Minor Changes

- 7b86b8e: fix(auth-oidc): make `cognitoFederated()` deployable by registering the IdP via a deploy-time custom resource

  `@aws-blocks/bb-app-setting` now also exports `SECRETS_BULK_CONSTRUCT_ID` — the
  construct id of the shared per-stack secret-init custom resource — so sibling
  blocks can order a resource after the SecureString values are written without
  hard-coding the string. `bb-auth-oidc`'s IdP-registration custom resource uses
  it to take an explicit dependency on that resource (compile-time coupling, so a
  rename can't silently break the ordering guarantee).

  `cognitoFederated()` previously produced a CloudFormation template that always
  failed to deploy (#447). It registered the federated identity provider with a
  native `AWS::Cognito::UserPoolIdentityProvider` resource, writing the IdP
  `client_id` / `client_secret` into `ProviderDetails` as
  `{{resolve:ssm-secure:...}}` dynamic references. CloudFormation only permits
  `ssm-secure` references on a small allowlist of properties that excludes
  `ProviderDetails`, so `cdk synth` succeeded but every deploy failed at
  change-set creation — before any resource was created — leaving the stack in
  `REVIEW_IN_PROGRESS` with `SSM Secure reference is not supported in [...ProviderDetails...]`.

  The IdP is now registered by a **deploy-time custom resource**: a small
  Lambda-backed provider reads and decrypts the IdP credential SecureString
  parameters via the SDK at deploy time and calls Cognito's
  `CreateIdentityProvider` / `UpdateIdentityProvider` / `DeleteIdentityProvider`.
  Only the parameter _names_ cross into the CloudFormation template — the secret
  values never appear in it. The handler's role is least-privilege: scoped to
  `cognito-idp:{Create,Update,Delete}IdentityProvider` on the pool ARN,
  `ssm:GetParameter` on the specific parameter ARNs, and `kms:Decrypt` conditioned
  on `kms:ViaService = ssm.<region>`.

  A `secret: true` `AppSetting` is an SSM SecureString at `/<fullId>` (not an AWS
  Secrets Manager entry — the `blocks secret` CLI does not apply). Set its value by
  writing the SecureString directly (`aws ssm put-parameter … --type SecureString
--overwrite`) or via the `AppSetting` runtime `put()`. Because the credentials
  are read at deploy time and are not stack properties, the custom resource
  re-reads SSM on every `cdk deploy`, so a credential set or rotation takes effect
  on the next deploy. A synth-time check rejects two providers configured with the
  same `identityProvider`.

  Verified end-to-end against a real account: `cdk deploy` succeeds (no change-set
  rejection) and the identity provider is created on the User Pool, including the
  path where a real `AppSetting(secret: true)` provisions the SecureString during
  the same deploy.

  This is a `minor` bump for `@aws-blocks/bb-auth-oidc` (pre-1.0 minor = a behavior
  change): the synthesized template for a `cognitoFederated()` provider no longer
  contains a native `UserPoolIdentityProvider` resource — the IdP is now a custom
  resource — so anyone asserting on that resource in a snapshot will see a diff.
  The public API is unchanged.

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
- 6496713: feat(core): constructor-forced VPC requirements, lazy VPC, and Database subnet control

  Continues the VPC review follow-ups (net-new, unreleased VPC feature).

  **Building Blocks declare VPC requirements via the constructor, not a method.**
  `BuildingBlockScope` is no longer abstract: its constructor takes the block's VPC
  requirements (a value, or a callback for values that depend on `fullId`) and
  registers them in a central per-stack registry. This keeps the compile-time
  forcing the previous `abstract getVpcRequirements()` provided — a block can't
  silently omit its requirements — without a standing method on every subclass, and
  gives the framework one place to read, deduplicate, and answer "does anything here
  need a VPC?". All Building Blocks were migrated to pass requirements to `super()`.

  **VPC is now a derived resource, not a hard prerequisite.** A block that cannot
  function without a VPC declares `requiresVpc: true`; when one is needed and the
  customer didn't bring their own, Blocks lazily creates a single shared VPC
  (generalizing the create-if-absent behavior `bb-data` already used for Aurora) and
  emits a notice about the NAT cost. Setting `defaults.vpc = { network }` remains the
  bring-your-own override.

  **`Database` accepts an optional `subnets` placement.** A CDK-free mirror of
  `ec2.SubnetSelection` (tier as a string, subnets by id) lets you steer where the
  Aurora cluster lands — for a bring-your-own VPC that lacks an isolated tier, or a
  compliance requirement to use specific subnets. Omit it to keep the default
  (prefer isolated, fall back to `private-with-egress`).

- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/core@0.5.0
  - @aws-blocks/bb-logger@0.2.0

## 0.2.1

### Patch Changes

- c45eb92: Extend stack-wide `BlocksDefaults` (introduced in the Infrastructure Options work) with three additive fields, and adopt them across the Blocks-managed infrastructure. Each field is read independently via `option ?? scope.defaults.field` — a per-block option always wins, and no field is derived from another.

  `@aws-blocks/core/cdk` now adds to `BlocksDefaults` (and both `BlocksPresets`):

  - `logRetention: RetentionDays` — how long Blocks-managed CloudWatch log groups keep events. Preset sandbox `ONE_WEEK`, production `ONE_YEAR`.
  - `throttling: { rateLimit, burstLimit }` — request-rate limits applied to every Blocks API Gateway stage. Preset sandbox `200 / 400`, production `1000 / 2000`.
  - `accessLogging: boolean` — structured JSON access logs on every Blocks API Gateway stage. **Off by default in both presets** (opt-in), because enabling it mutates the account/region-level API Gateway CloudWatch role singleton.

  Also newly exported from `@aws-blocks/core/cdk`: the `BlocksThrottling` type and `ensureApiGatewayAccount()` (provisions the account-level API Gateway CloudWatch Logs role once per stack). `Scope` gains a `handlerLogGroup` getter for the shared handler log group.

  **Log retention** — Blocks-managed log groups now follow `defaults.logRetention` instead of AWS's infinite default: the shared handler Lambda (now owned by `BlocksStack`/`BlocksBackend` as `scope.handlerLogGroup`), the `bb-distributed-table` GSI-manager Lambdas, the `bb-distributed-data` DSQL migration Lambda, the `bb-data` Aurora migration Lambda, and the `bb-app-setting` secret-init Lambda. `bb-logger` reconfigures the shared handler group's retention — **only when an explicit per-Logger `retention` is set** (a bare `Logger` no longer writes it back, so it can't clobber another Logger's value) — rather than creating its own `/aws/lambda/<fn>` group. (Note: the framework `custom-resources.Provider` Lambdas these BBs wrap still use AWS's default retention — the L2 `Provider` exposes no log-group/retention override.)

  **Throttling** — applied to the core REST API stage and the `bb-realtime` WebSocket stage. On a WebSocket stage the throttle unit is messages/second across the connection.

  **Access logging** — when enabled, each stage writes structured JSON access logs to a dedicated CloudWatch log group (retention = `defaults.logRetention`, removal policy = `defaults.removalPolicy` so production **RETAIN**s the audit trail on teardown). The account-level API Gateway CloudWatch Logs role is provisioned once per stack and shared across stages.

  **⚠️ Behavior changes on upgrade:**
  - **Throttling now caps the core REST API and WebSocket stages.** Before this change these stages had no stage-level throttle (they ran at the API Gateway account default, ~10k rps). After upgrade, sandbox is capped at 200 rps / 400 burst and production at 1000 rps / 2000 burst. Apps serving above the production ceiling will see `429`s — raise it with a per-stack `throttling` override (`defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`).
  - **The shared handler Lambda log group changes.** The handler previously logged to Lambda's auto-created `/aws/lambda/<fn>` group (infinite retention); it now logs to a framework-owned group with the default retention. On upgrade the old auto group is left orphaned in CloudWatch (unmanaged, still infinite) — delete it manually if you want its history/cost gone. Likewise a `bb-logger`-created retention group from a prior version is replaced.
  - **Access logging** is **opt-in (off in both presets)**. When enabled it requires the account-level API Gateway CloudWatch Logs role — an account/region-level singleton, so enabling it is safe for **one Blocks stack per region** (see `ensureApiGatewayAccount()` for the multi-stack teardown caveat). It defaults off (rather than on for production) so an upgrade never mutates that account-wide singleton without an explicit opt-in.
  - **`BlocksDefaults` gains three required fields** (`logRetention`, `throttling`, `accessLogging`). Apps that spread a `BlocksPresets` preset (the documented path) are unaffected; code that hand-rolls a literal `BlocksDefaults` object will need to add the new fields to compile.

  `bb-dashboard` now points its log widgets at the framework-owned handler log
  group (`scope.handlerLogGroup.logGroupName`) instead of reconstructing
  `/aws/lambda/<fn>` — the handler now writes to a dedicated group with a
  CDK-generated name, so the old convention would leave the "Recent Errors" /
  "Log Volume" widgets querying an empty group.

  Hosting adoption of these defaults (SSR REST API + compute log groups) ships in a separate change.

- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6

## 0.2.0

### Minor Changes

- 1ff9d03: `AppSetting`: support a customer-managed KMS key for secrets via `kmsKeyArn`.

  Secret (`SecureString`) parameters were always encrypted with the default `aws/ssm` AWS-managed key, so their decrypt scope couldn't be controlled (e.g. for cross-account access or a dedicated key policy). Passing `kmsKeyArn` (also accepted by `AppSetting.fromExisting`) now encrypts the secret with that customer-managed key:

  - the bulk-init Custom Resource creates the parameter with the CMK (`KeyId`);
  - the shared handler is granted `kms:Decrypt`/`Encrypt` scoped to that specific key ARN (instead of the `aws/ssm` `ViaService` wildcard);
  - the runtime `put()` re-specifies the key on overwrite so it doesn't silently fall back to `aws/ssm`;
  - adding/changing/removing `kmsKeyArn` on an already-deployed secret re-encrypts its current value under the new key at deploy time, so decryption keeps working after a key rotation.

  `kmsKeyArn` is only valid with `secret: true` and must be a non-empty ARN. The default (no `kmsKeyArn`) is unchanged.

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role

  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.

  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.

- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-logger@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements
- Updated dependencies [18880ff]
  - @aws-blocks/core@0.1.2

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
