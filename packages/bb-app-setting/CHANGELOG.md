# @aws-cdk-blocks/bb-app-setting

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-app-setting` 0.x

- The package is now `@aws-cdk-blocks/bb-app-setting`. Install it in place of `@aws-blocks/bb-app-setting`, and change the import specifiers.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that `value` is required unless `secret: true`, that `ParameterNotFound` is thrown on AWS only, and that `get()` parses the stored text as JSON. `fromExisting` does not create the parameter or grant write access.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.

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

### Patch Changes

- e83d152: `AppSetting.get()` on AWS now throws `AppSettingErrors.ParameterNotFound` when the SSM parameter does not exist, as documented, instead of the raw SDK `ParameterNotFound` exception.
- c6a3357: `AppSetting.put()` on AWS enforces the documented 4 KB limit before writing, the same way the local mock does. A non-secret value whose JSON serialization exceeds 4096 UTF-8 bytes throws `AppSettingErrors.ValidationFailed` and is not sent to SSM.
- 5f55dac: Adds two read-only properties to `AppSetting`'s CDK construct at synth time, `parameterName` and `secret`. `parameterName` is the SSM parameter name the setting resolves to, including an explicit `name` or an `AppSetting.fromExisting()` name.

- c67048e: **Breaking: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block, and `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data`, and `@aws-blocks/data-common` are removed.**

  To upgrade:

  1. Import `Database`, `DatabaseCluster`, `DatabaseErrors`, and `sql` from `aws-cdk-blocks`.
  2. To keep an old `@aws-blocks/bb-data` cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it.
  3. Replace `DistributedDatabase` with a `Database` of the same id, which keeps its cluster.
  4. Replace `Database.fromExisting()` with `DatabaseCluster.fromExisting()`, passed as `cluster`.
  5. Replace `withRLS()` with `asUser()` or `asRole()`, and use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely` for Kysely.
  6. Store the connection string of an existing database with `npm run db -- connect --stage <stage>`, not a `*_DB_URL` or `*_CONNECTION_STRING` environment variable.

  Data is not moved, and `crud()`, `ensureSecrets`, and the `npm run db` commands `pull` and `generate-types` are removed.

- a5f39c3: The docs describe the status 409 of a failed `KVStore` condition, the local data files of `KVStore` and `AppSetting`, and how a `RawRoute` fills `params` under `npm run dev`.
- 5f55dac: Docs and editor hover text point at `Auth` instead of the removed `AuthBasic`, `AuthCognito`, and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table.
- 0ff1e1f: The AppSetting and Secret docs describe the installed version. The Secret docs no longer promise managed rotation, which `Secret` does not expose.
- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.

- e1e4844: **Breaking: the `cdk-blocks` executable is removed, and AWS Blocks tasks run through your app's package manager.**

  To upgrade:

  1. Upgrade `aws-cdk-blocks`.
  2. From the app directory, run `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run` and review the plan.
  3. Run the same command without `--dry-run` from a clean Git working tree.
  4. Change by hand the custom wrappers that the migration reports.

  Structured tasks such as `npm run docs KVStore`, `npm run docs:api KVStore`, and `npm run docs:search "partition key"` print text in a terminal and JSON on a pipe or redirect.

- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

## 0.4.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- 43603b0: The secret-init custom-resource Lambda, `BlocksSecretInitFn`, has a 2-minute timeout instead of Lambda's 3-second default. A slow cold start no longer rolls back the deploy of a stack that uses `AppSetting` with `secret: true`.
- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- 48c35f6: The `cdk` and `browser` entry points export the names they were missing, so importing them during `cdk synth` or in a browser bundle no longer fails. The `browser` entries add the error constants `AgentErrors`, `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors`.
- 48c35f6: Two Building Blocks that would handle the same Lambda event, or that register the same config key with different values, fail `cdk synth`. Ids such as `orders-a` and `orders_a` collide on the config key, so rename one of the blocks.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.3.2

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.

- 66f4be2: **Breaking: `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler` are removed.**

  To upgrade:

  1. Replace `blocksStack.handler.addEnvironment('KEY', value)` with `registerConfig(blocksStack, 'KEY', value)`.
  2. Replace `resource.grantRead(blocksStack.handler)` with `resource.grantRead(blocksStack.executionRole)`.
  3. Replace `blocksStack.handler.addToRolePolicy(statement)` with `blocksStack.executionRole.addToPrincipalPolicy(statement)`.
  4. In a custom Building Block, replace `this.handler` with `this.executionRole` or `registerConfig(this, …)`.
  5. Replace `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` with `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`.

  A real environment variable of the same name wins over a `registerConfig` entry, where the last `addEnvironment` call won before.

- ec7eebe: The docs recommend `Secret` for any credential that protects a production app, and describe `AppSetting` with `secret: true` as a free, encrypted fallback for a low-value secret.

## 0.3.1

### Patch Changes

- 0e18d5b: The local AppSetting mock rejects the same invalid option combinations as CDK synth and throws `ValidationFailedException`. A config that the mock used to accept, such as a non-secret setting with no `value`, now throws in local dev.
- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.3.0

### Minor Changes

- 7b86b8e: `cognitoFederated()` registers the identity provider with a deploy-time custom resource, so the stack deploys instead of failing at change-set creation. `@aws-blocks/bb-app-setting` exports `SECRETS_BULK_CONSTRUCT_ID`, the construct id of the shared per-stack secret-init custom resource.

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.

## 0.2.1

### Patch Changes

- c45eb92: **Breaking: `BlocksDefaults` gains three required fields, `logRetention`, `throttling`, and `accessLogging`, and the presets now throttle the API stages and replace the shared handler Lambda log group.**

  To upgrade:

  1. Add the three fields to any hand-written literal `BlocksDefaults` object, which is not needed when you spread a `BlocksPresets` preset.
  2. If your app serves above 1000 rps / 2000 burst in production, raise the limit with `defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`.
  3. Delete the old `/aws/lambda/<fn>` log group manually if you want its history gone.

  Sandbox is capped at 200 rps / 400 burst, and Blocks-managed log groups keep events for `ONE_WEEK` in sandbox and `ONE_YEAR` in production.

## 0.2.0

### Minor Changes

- 1ff9d03: Adds `kmsKeyArn` to `AppSetting` and `AppSetting.fromExisting` to encrypt a secret with a customer-managed KMS key instead of the default `aws/ssm` key. `kmsKeyArn` is only valid with `secret: true` and must be a non-empty ARN.

### Patch Changes

- 309a236: Data and auth blocks grant permissions to the shared Blocks execution role instead of the handler function. The effective runtime permissions are identical.

## 0.1.4

Dependency updates only.

## 0.1.3

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
