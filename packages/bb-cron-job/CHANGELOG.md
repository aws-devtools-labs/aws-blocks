# @aws-cdk-blocks/bb-cron-job

## 1.0.0

The first stable release, with no changes since 1.0.0-rc.2. The notes for every change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-cron-job` 0.x

- The package is now `@aws-cdk-blocks/bb-cron-job`. Install it in place of `@aws-blocks/bb-cron-job`, and change the import specifiers.
- 3ae8592: Run a CronJob on a container compute for long-running jobs.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that a job with `enabled: false` is deployed in the `DISABLED` state and cannot be triggered by hand. `InvalidSchedule` and `InvalidTimezone` are thrown at construction locally and at synth on deploy.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.

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

- 3ae8592: `CronJob` takes the same `compute` and `timeoutSeconds` options as `AsyncJob`. Assign a container `Compute` to run a scheduled job longer than a serverless compute's 15-minute limit.

### Patch Changes

- 777c5a4: In local development, a `CronJob` whose `rate(...)` is longer than about 24.8 days, such as `rate(30 days)`, fires once per interval instead of every millisecond.
- 0ff1e1f: The AsyncJob and CronJob design docs describe the installed version. Batch limits, status tracking, and per-job grants are stated as current behaviour.
- e8673cd: The docs and `UnsupportedCompute` errors state that `AsyncJob` and `CronJob` support Lambda and container delivery, while `Realtime` requires default Lambda compute. Omitting container concurrency allows five in-flight deliveries per job per instance, not one per vCPU, and the docs now say so.
- 8a5726c: Test-only change that checks `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob, and Dashboard. No runtime or synth behavior changes.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

## 0.4.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- 8565ef7: Adds a `compute` option to `Scope`, which places everything created under it on one `Compute`, and to `CronJob`, serverless only. A `CronJob` or `AsyncJob` whose compute belongs to a different backend fails synth with an error naming the compute.

### Patch Changes

- 72b5fe0: The local mock accepts month names from `JAN` to `DEC` in the cron month field, so schedules like `cron(0 9 1 JAN ? *)` fire locally. Cron field values must be whole integers, so values such as `9am` or `0/15x` throw `InvalidScheduleExpression` instead of being truncated.
- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- 48c35f6: Two Building Blocks that would handle the same Lambda event, or that register the same config key with different values, fail `cdk synth`. Ids such as `orders-a` and `orders_a` collide on the config key, so rename one of the blocks.
- 492d744: The local CronJob mock no longer runs a cron job on a date its schedule doesn't match. A schedule with no match within a year, or with a fire time more than about 24.8 days away, waits for the real fire time.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 9aa8ae2: The API docs state that `AsyncJob`'s `maxRetries` counts total delivery attempts including the first, and that `CronJobEvent.jobName` is the CronJob's fully-qualified id. The `DashboardErrors` example compiles and catches `InvalidMetricConfig` where it is thrown.
- ce5dfa9: Adds the `Compute` Building Block, `new Compute(scope, id, { type, ...options })`, where the type is `serverless` or `container`. `AsyncJob({ compute })` runs a job on a container on AWS Fargate, and Blocks provisions one shared VPC per backend for containers.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.3.0

### Minor Changes

- da6d4c7: **Breaking: shared Blocks resources are scoped to the `BlocksStack` or `BlocksBackend` instead of the enclosing `cdk.Stack`.** An app that embeds a `BlocksBackend` inside a customer `cdk.Stack` and uses realtime or cron sees those resources replaced on upgrade. For realtime, the WebSocket API URL changes and the stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>`, so update scripts that read that output by name. Single-`BlocksStack` apps see no resource replacement.

### Patch Changes

- 023f02c: An internal refactor routes the remaining per-package errors through core's `blocksError`. Two realtime timeout rejections that were unbranded are now wire-safe.

## 0.2.2

### Patch Changes

- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.
- 7b7a59f: The EventBridge Scheduler role's trust policy is limited to schedules in the stack's account and region. Hosting removes a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key policy.

## 0.2.1

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- d7312f9: The CDK tests' stub `Compute` implements the new observability hooks of the `Compute` base class, with no runtime or public API change.

## 0.2.0

### Minor Changes

- 165093b: `CronJob` validates the schedule and timezone at synth and throws `CronJobErrors.InvalidSchedule` or `CronJobErrors.InvalidTimezone` before any infrastructure is created. The local mock throws the new `CronJobErrors.ScheduleNotSupported` for valid `cron(...)` forms it cannot simulate.
- 4a830a6: AsyncJob, CronJob, and Realtime attach their resources to a compute resolved at synth, and fail synth with an `UnsupportedCompute` error on anything but a Lambda compute. `@aws-blocks/core` exports `blocksError(name, message)` and `sanitizeConfigKey(id)`.

## 0.1.5

Dependency updates only.

## 0.1.4

Dependency updates only.

## 0.1.3

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.2

### Patch Changes

- 4758fd3: Stepped cron ranges such as `0-30/10` stop at their upper bound. Inverted values such as `30-10` and out-of-bounds values such as `100` or `0-100/5` are rejected.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
