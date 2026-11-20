# @aws-cdk-blocks/bb-async-job

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-async-job` 0.x

- The package is now `@aws-cdk-blocks/bb-async-job`. Install it in place of `@aws-blocks/bb-async-job`, and change the import specifiers.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that locally a failed delivery is retried at once and an exhausted job is logged, not queued. On AWS the retry wait is `900 + maxBatchingWindowSeconds` seconds on a Lambda compute and about 2 minutes on a container compute.

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

- 6423964: Clarify in the README that `maxRetries` counts total deliveries including the first (`3` = one attempt plus two retries), matching the queue's `maxReceiveCount`.
- 3ae8592: A deploy no longer resets the task count of an autoscaled container `Compute` to `minInstances`. A job that is running when its task is stopped gets up to 120 seconds to finish, up from 25 seconds.
- 0ff1e1f: The AsyncJob and CronJob design docs describe the installed version. Batch limits, status tracking, and per-job grants are stated as current behaviour.
- e8673cd: The docs and `UnsupportedCompute` errors state that `AsyncJob` and `CronJob` support Lambda and container delivery, while `Realtime` requires default Lambda compute. Omitting container concurrency allows five in-flight deliveries per job per instance, not one per vCPU, and the docs now say so.
- 6d3077e: `Agent`, `AsyncJob`, and `Realtime` compose `KVStore` instead of `DistributedTable`, and a deployed stack updates in place. Every read hides expired job-status records and connection records.

## 0.3.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- ce5dfa9: Adds the `Compute` Building Block, `new Compute(scope, id, { type, ...options })`, where the type is `serverless` or `container`. `AsyncJob({ compute })` runs a job on a container on AWS Fargate, and Blocks provisions one shared VPC per backend for containers.

### Patch Changes

- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- 48c35f6: The `cdk` and `browser` entry points export the names they were missing, so importing them during `cdk synth` or in a browser bundle no longer fails. The `browser` entries add the error constants `AgentErrors`, `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors`.
- 48c35f6: Two Building Blocks that would handle the same Lambda event, or that register the same config key with different values, fail `cdk synth`. Ids such as `orders-a` and `orders_a` collide on the config key, so rename one of the blocks.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 9aa8ae2: The API docs state that `AsyncJob`'s `maxRetries` counts total delivery attempts including the first, and that `CronJobEvent.jobName` is the CronJob's fully-qualified id. The `DashboardErrors` example compiles and catches `InvalidMetricConfig` where it is thrown.
- 8565ef7: Adds a `compute` option to `Scope`, which places everything created under it on one `Compute`, and to `CronJob`, serverless only. A `CronJob` or `AsyncJob` whose compute belongs to a different backend fails synth with an error naming the compute.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.3

### Patch Changes

- 3a7eb9e: The `cdk` entry points export the runtime values they were missing, such as `InterruptError` in `@aws-blocks/bb-agent` and `BatchSubmitFailedError` in `@aws-blocks/bb-async-job`. Importing them in a backend file no longer crashes `cdk synth`.
- 023f02c: An internal refactor routes the remaining per-package errors through core's `blocksError`. Two realtime timeout rejections that were unbranded are now wire-safe.

## 0.2.2

### Patch Changes

- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.2.1

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- d7312f9: The CDK tests' stub `Compute` implements the new observability hooks of the `Compute` base class, with no runtime or public API change.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.

## 0.2.0

### Minor Changes

- 4a830a6: AsyncJob, CronJob, and Realtime attach their resources to a compute resolved at synth, and fail synth with an `UnsupportedCompute` error on anything but a Lambda compute. `@aws-blocks/core` exports `blocksError(name, message)` and `sanitizeConfigKey(id)`.

## 0.1.5

### Patch Changes

- 5798492: `AsyncJob` batches SQS messages with a default `batchSize: 10`, up from `batchSize: 1`, and a new `maxBatchingWindowSeconds` option with a default of 5. Set `batchSize: 1` and `maxBatchingWindowSeconds: 0` to opt out.
- ca8cfb6: `submitBatch` accepts up to 10,000 payloads and splits them into SQS requests, where it rejected more than 10 with `BatchTooLarge` before. A batch that spans several chunks is not atomic, and the `BatchSubmitFailed` error carries `.jobIds` and `.failed[]` so you can retry only the failed indexes.

## 0.1.4

Dependency updates only.

## 0.1.3

### Patch Changes

- f583c75: Adds opt-in job status tracking to `AsyncJob`. Pass `trackStatus: true`, which provisions one DynamoDB table with a 24 hour TTL, then read a job's states with `getStatus(jobId)` and `waitUntilComplete(jobId, options?)`.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
