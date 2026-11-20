# @aws-cdk-blocks/bb-dashboard

## 1.0.0

The first stable release, with no changes since 1.0.0-rc.2. The notes for every change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-dashboard` 0.x

- The package is now `@aws-cdk-blocks/bb-dashboard`. Install it in place of `@aws-blocks/bb-dashboard`, and change the import specifiers.
- 1de6ea4: The reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*` and others). `/aws-blocks/` still works as an alias.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The README documents the `metrics` source, how dashboard names are normalized, and when trace widgets are available.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- b47e4c7: The Dashboard block's route opens during local development, where it shows configured metrics and local observability output and launches the Admin UI. New Admin UI sessions start on local data and defer AWS reads until a cloud stage is selected.

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

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

### Patch Changes

- 0ff1e1f: The Dashboard and Logger docs describe the installed version. The Logger README points at `Compute`'s `logRetention` for per-compute retention.
- 8a5726c: Test-only change that checks `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob, and Dashboard. No runtime or synth behavior changes.

## 0.3.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- 48c35f6: Two Building Blocks that would handle the same Lambda event, or that register the same config key with different values, fail `cdk synth`. Ids such as `orders-a` and `orders_a` collide on the config key, so rename one of the blocks.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 9aa8ae2: The API docs state that `AsyncJob`'s `maxRetries` counts total delivery attempts including the first, and that `CronJobEvent.jobName` is the CronJob's fully-qualified id. The `DashboardErrors` example compiles and catches `InvalidMetricConfig` where it is thrown.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.2

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.

## 0.2.1

### Patch Changes

- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.
- e57da06: Report bbName/bbVersion in telemetry.

## 0.2.0

### Minor Changes

- d7312f9: **Breaking: logging, tracing, and the dashboard are driven by each compute, and `Logger` drops its `retention` option and the `LOG_LEVEL` environment variable.**

  To upgrade:

  1. Replace the `retention` option of `LoggingOptions` with the `logRetention` prop on `LambdaCompute`, which falls back to `defaults.logRetention`.
  2. Set the log level with the `level` option of each `Logger`, which defaults to `'info'`, instead of the `LOG_LEVEL` environment variable.
  3. Remove uses of the `LoggerBBRef` and `TracerBBRef` dashboard types.

  Creating any `Tracer` in the app enables X-Ray on every compute, and `DashboardOptions` gains the `logs` and `traces` display toggles.

### Patch Changes

- 4342149: `bb-dashboard` declares its `@aws-blocks/bb-lambda-compute` devDependency as `^0.4.0`, with no runtime or API change.
- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.1.5

### Patch Changes

- c45eb92: **Breaking: `BlocksDefaults` gains three required fields, `logRetention`, `throttling`, and `accessLogging`, and the presets now throttle the API stages and replace the shared handler Lambda log group.**

  To upgrade:

  1. Add the three fields to any hand-written literal `BlocksDefaults` object, which is not needed when you spread a `BlocksPresets` preset.
  2. If your app serves above 1000 rps / 2000 burst in production, raise the limit with `defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`.
  3. Delete the old `/aws/lambda/<fn>` log group manually if you want its history gone.

  Sandbox is capped at 200 rps / 400 burst, and Blocks-managed log groups keep events for `ONE_WEEK` in sandbox and `ONE_YEAR` in production.

## 0.1.4

Dependency updates only.

## 0.1.3

Dependency updates only.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
