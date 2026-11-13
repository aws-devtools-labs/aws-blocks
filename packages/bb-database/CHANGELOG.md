# @aws-blocks/bb-database

## 0.2.0

### Minor Changes

- 06355de: `DatabaseCluster` gains `type: 'aurora'`: Aurora PostgreSQL Serverless v2 created with the express configuration. The cluster is created in seconds together with its writer instance, runs outside any VPC behind an internet access gateway, scales to zero (`minCapacity: 0`, the default) and is reached with IAM authentication only; the master user has no password and the app connects as its own database role with a short-lived token. `minCapacity` and `maxCapacity` set the ACU range, `pointInTimeRecovery` the backup window, and `removalPolicy` accepts `'snapshot'`.

  Blocks on an `aurora` cluster get all of PostgreSQL: triggers, PL/pgSQL, extensions, Row Level Security, transactions of any size. Their migration files are PostgreSQL and run as written, one transaction per file; `dsql-lint` and the DSQL transaction limits apply to `dsql` clusters only, locally and on AWS. An `aurora` migration file that carries a DSQL-only form (`ASYNC`, `sys.wait_for_job()`) is stopped before it runs, with a message that names the file and what to change; the error for a rejected migration file is now `MigrationValidationError` for both kinds. `npm run dev` prints one line per migration run that applied files, naming the schema and the data directory. `db.cluster.kind` is now `'dsql' | 'aurora'`. `DsqlDatabaseOptions` is renamed `SharedDatabaseOptions`.

  On AWS an `aurora` migration file must finish within the migration function's ten-minute invocation: a longer transaction is cancelled by the server and the error names the file and the statement, and a failed `aurora` file reports that nothing from it was applied and that it runs again from the start. Storage is encrypted with an AWS-owned key; the express configuration accepts no customer managed KMS key.

- f45b407: `@aws-blocks/bb-database/kysely` exports `DatabaseDialect`, a Kysely dialect for a `Database`: `new Kysely<Tables>({ dialect: new DatabaseDialect(db) })`. Kysely is an optional peer dependency of the block; the application installs it. Statements run through the block's engine, so they use the block's schema and fail with the same `DatabaseErrors` names, and affected-row counts come from the engine. A Kysely statement inside the block's `transaction()` callback runs in that transaction. Inside a Kysely transaction, run every statement on `trx`; in local mode a statement on the block or on the root Kysely instance fails after five seconds instead of waiting. Streaming is not supported.

  The entry points of `@aws-blocks/bb-database` no longer load Kysely. The block imported the root of `@aws-blocks/data-common`, which loads the Kysely adapter. It now imports the new `@aws-blocks/data-common/core` entry, which has every root export except `createKyselyAdapter()`. The root entry of `@aws-blocks/data-common` is unchanged.

- 4e41c28: feat(bb-database): add `@aws-blocks/bb-database`, a preview of one `Database` block that runs on a cluster

  - `Database` owns an Aurora DSQL cluster by default, or runs on a shared `DatabaseCluster` (`type: 'dsql'`) with one schema per block. Migrations are written in DSQL, as AWS documents it, and run as written: every file is checked with AWS's `dsql-lint` locally and at synth (a PostgreSQL spelling such as `SERIAL` or `CREATE INDEX` without `ASYNC` stops the deploy with the linter's suggestion), each DDL statement runs in its own transaction, and the runner waits for the jobs that `ASYNC` statements start, resumes a failed file at the failed step (a failed `ASYNC` job rewinds to its statement and drops the `INVALID` index it left, and a job purged from `sys.jobs` is verified in the catalog), and refuses a file that was edited after a partial run (restore the text to finish it, and put the change in a new file); app functions wait for a block's migrations, and DSQL jobs are polled for up to 55 minutes, inside the one hour CloudFormation waits for a custom resource.
  - `@aws-blocks/blocks` does not depend on or re-export the block yet; import from `@aws-blocks/bb-database`.
  - `query()` and `queryOne()` take `{ schema }`, a Standard Schema (Zod, Valibot, ArkType) that types the result from a value and validates every row; a mismatch is `DatabaseErrors.ResultValidationFailed`, whose message names the row index and the field while the library's issue text stays on the server. The same option is on the `tx` a `transaction()` callback receives.
  - An `ApiError` or any branded Blocks error thrown inside `transaction()` reaches the caller unchanged (a 404 stays a 404); only other errors become `TransactionFailed`.
  - `db.query()`, `db.queryOne()` and `db.execute()` called inside the block's own `transaction()` callback run in that transaction, locally and on DSQL.
  - Locally, a call to another block on the same cluster from inside a `transaction()` callback runs inside that transaction as a savepoint instead of waiting on the single PGlite session; on DSQL it runs on its own connection. The README's Local mode section describes the difference.
  - `bigint` results (identity columns, `count(*)`, `sum()` over integers) are JavaScript numbers on DSQL as they are locally; a value beyond ±2^53 is a `BigInt` in both.
  - The test helper `simulateConflict(db)` lives in `@aws-blocks/bb-database/testing`; the block's runtime class exposes only `query`, `queryOne`, `execute`, `transaction`, `cluster` and `schemaName`.
  - A renamed `Database` or `DatabaseCluster` id keeps the old cluster and its data under the default `retain` removal policy, but points the app at a new, empty one. The deploy guard that stops such a move is a separate change.

### Patch Changes

- 58817b0: fix(core): add aws:SourceAccount/aws:SourceArn conditions to service-principal trust policies; add synth-time check

  The IAM roles AWS Blocks creates for a backend now scope every service-principal trust to the stack's account:

  - The `KnowledgeBase` Bedrock service role adds `aws:SourceArn` matching `arn:<partition>:bedrock:<region>:<account>:knowledge-base/*` beside its existing `aws:SourceAccount` condition.
  - The waiter state machine roles of the `DistributedTable` index provider and the `Database` migration provider trust `states.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:states:<region>:<account>:stateMachine:*`.
  - The `ContainerCompute` task execution role trusts `ecs-tasks.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:ecs:<region>:<account>:*`, the same scope as its task-role trust.
  - The `Auth` SMS role (created for phone sign-in or SMS MFA) trusts `cognito-idp.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:cognito-idp:<region>:<account>:userpool/*`, beside the `sts:ExternalId` it already had.
  - The `@aws-blocks/hosting` API Gateway REST door no longer creates CDK's per-API CloudWatch role and `AWS::ApiGateway::Account` setting; its stage configures no logging.

  Synth now checks the roles AWS Blocks covers for a backend for a service-principal trust with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition. That is the same set of roles `defaults.permissionsBoundary` applies to: for a `BlocksStack` the whole stack, for an embedded `BlocksBackend` its subtree and the stack-level roles created on its behalf. Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`) are accepted as they are, as is the `apigateway.amazonaws.com` trust of an API Gateway CloudWatch Logs role: any role an `AWS::ApiGateway::Account` in the same stack names as its `cloudWatchRoleArn`, such as `BlocksApiGatewayCloudWatchRole` (created by `@aws-blocks/core` and `@aws-blocks/hosting` when access logging is on) or the default `cloudWatchRole` of a CDK `RestApi` the app adds. That trust stays unconditioned: API Gateway does not send `aws:SourceAccount` or `aws:SourceArn` when it delivers logs with this role, so a condition stops log delivery.

  - A role AWS Blocks creates (under an AWS Blocks Building Block or a compute, or at stack scope on a block's behalf) fails synth; the error names the role's construct path and the principal.
  - A role the app creates gets a synth warning instead, and synth succeeds: one its backend module adds (on a `BlocksStack` or an embedded `BlocksBackend`, at stack scope, under a `Scope` namespace, or inside a custom block the app writes as a `Scope` subclass), one added to a `BlocksStack` after `create()`, and one a CDK construct creates inside any of these (for example the `EventsRole` of an `events.Rule` targeting a state machine).

  Ownership follows who created the role: AWS Blocks' own blocks, computes and stack-level helpers mark the constructs they create, and every other covered role is the app's.

  To resolve the warning, add both conditions to the role's trust statement. For a role a CDK construct creates with no prop for its trust, set them with `role.node.defaultChild.addPropertyOverride('AssumeRolePolicyDocument.Statement.N.Condition', { ... })`; the warning names `N`. To keep the trust as it is, acknowledge the warning with `Annotations.of(role).acknowledgeWarning('@aws-blocks/core:serviceRoleTrustWithoutSourceCondition')`, or on the stack for every role in it. See "Service-principal trust" in the `@aws-blocks/core` README.

- Updated dependencies [5f55dac]
- Updated dependencies [2eb62fa]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [6297d5a]
- Updated dependencies [f45b407]
- Updated dependencies [b2eb306]
- Updated dependencies [a5e754b]
- Updated dependencies [f133ff8]
- Updated dependencies [9ebf67a]
- Updated dependencies [76fd75c]
- Updated dependencies [3ae8592]
- Updated dependencies [e5822ed]
- Updated dependencies [3ae8592]
- Updated dependencies [9059918]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [b2eb306]
- Updated dependencies [0cf1aa2]
- Updated dependencies [15e65b4]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [c045273]
- Updated dependencies [369b175]
- Updated dependencies [d7f62f3]
- Updated dependencies [3be61fa]
- Updated dependencies [36888a1]
- Updated dependencies [fcf087d]
- Updated dependencies [2c9005f]
- Updated dependencies [6151940]
- Updated dependencies [b7c262c]
- Updated dependencies [ebfe2ed]
- Updated dependencies [c1fabce]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [44c7377]
- Updated dependencies [2a358ff]
- Updated dependencies [1ec956f]
- Updated dependencies [c1fabce]
- Updated dependencies [072c3ff]
- Updated dependencies [5f55dac]
- Updated dependencies [afad513]
- Updated dependencies [ba80bbd]
- Updated dependencies [05a88e1]
- Updated dependencies [f32185c]
- Updated dependencies [ee557d4]
- Updated dependencies [f32185c]
- Updated dependencies [9801a5b]
- Updated dependencies [a86bccb]
- Updated dependencies [b2eb306]
- Updated dependencies [df25d97]
- Updated dependencies [201e59e]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [60360c1]
- Updated dependencies [8ece10a]
- Updated dependencies [c607deb]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [2095f31]
- Updated dependencies [80ce128]
- Updated dependencies [d354055]
- Updated dependencies [58817b0]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-blocks/core@0.9.0
  - @aws-blocks/data-common@0.1.8
  - @aws-blocks/bb-logger@0.4.0
