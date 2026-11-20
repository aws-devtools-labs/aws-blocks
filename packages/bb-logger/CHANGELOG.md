# @aws-cdk-blocks/bb-logger

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-logger` 0.x

- The package is now `@aws-cdk-blocks/bb-logger`. Install it in place of `@aws-blocks/bb-logger`, and change the import specifiers.
- 4e92168: Every `Logger` line in a function run through `createLambdaHandler` carries the invocation's `awsRequestId`.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The retention example in the docs keeps the sandbox preset for sandbox stacks. The log level is set only through the `level` option.

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

### Minor Changes

- 4e92168: On the Lambda functions AWS Blocks runs through `createLambdaHandler`, every `Logger` line carries `awsRequestId`, the invocation's request id. The field is reserved, so your context can't replace it, and block authors can read the id with `currentRequestId()` from `@aws-cdk-blocks/core/bb-utils`.

### Patch Changes

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 0ff1e1f: The Dashboard and Logger docs describe the installed version. The Logger README points at `Compute`'s `logRetention` for per-compute retention.

## 0.3.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- a3969b5: `Logger` methods such as `log.info(...)` and `log.child(...)` work during `cdk synth` instead of crashing with `log.info is not a function`. Under `cdk` the logger writes the same structured JSON lines as at runtime.
- 48c35f6: The `cdk` and `browser` entry points export the names they were missing, so importing them during `cdk synth` or in a browser bundle no longer fails. The `browser` entries add the error constants `AgentErrors`, `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.2

Dependency updates only.

## 0.2.1

Dependency updates only.

## 0.2.0

### Minor Changes

- d7312f9: **Breaking: logging, tracing, and the dashboard are driven by each compute, and `Logger` drops its `retention` option and the `LOG_LEVEL` environment variable.**

  To upgrade:

  1. Replace the `retention` option of `LoggingOptions` with the `logRetention` prop on `LambdaCompute`, which falls back to `defaults.logRetention`.
  2. Set the log level with the `level` option of each `Logger`, which defaults to `'info'`, instead of the `LOG_LEVEL` environment variable.
  3. Remove uses of the `LoggerBBRef` and `TracerBBRef` dashboard types.

  Creating any `Tracer` in the app enables X-Ray on every compute, and `DashboardOptions` gains the `logs` and `traces` display toggles.

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.1.6

### Patch Changes

- c45eb92: **Breaking: `BlocksDefaults` gains three required fields, `logRetention`, `throttling`, and `accessLogging`, and the presets now throttle the API stages and replace the shared handler Lambda log group.**

  To upgrade:

  1. Add the three fields to any hand-written literal `BlocksDefaults` object, which is not needed when you spread a `BlocksPresets` preset.
  2. If your app serves above 1000 rps / 2000 burst in production, raise the limit with `defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`.
  3. Delete the old `/aws/lambda/<fn>` log group manually if you want its history gone.

  Sandbox is capped at 200 rps / 400 burst, and Blocks-managed log groups keep events for `ONE_WEEK` in sandbox and `ONE_YEAR` in production.

## 0.1.5

Dependency updates only.

## 0.1.4

Dependency updates only.

## 0.1.3

### Patch Changes

- 3c56267: `AuthBasic` and `Logger` report `bbName`/`bbVersion` to `Scope`, so telemetry names them like every other Building Block and `totalCount` rises for most applications. Telemetry still names only blocks on the official list, and customer-chosen block names stay counted but unnamed.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
