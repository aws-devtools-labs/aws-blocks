# @aws-cdk-blocks/bb-email-client

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-email-client` 0.x

- The package is now `@aws-cdk-blocks/bb-email-client`. Install it in place of `@aws-blocks/bb-email-client`, and change the import specifiers.
- 64f7247: `EmailClient.sendBatch()` now takes at most 100 messages per call by default.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs no longer have the "Package Export Conditions" section, which did not match the package manifest.

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

- 64f7247: `EmailClient.sendBatch()` takes at most 100 messages per call by default and throws `InvalidInputException` for a larger batch, where it took any number before. Split the messages across calls, or set the new `maxBatchSize` option to raise the cap.

### Patch Changes

- 382b4fa: The README explains why the block doesn't rate-limit callers and what happens to the app's SES account when an app that sends on a caller's behalf adds no limit. It also shows one way to add a per-user limit with a `KVStore` counter.
- 450e25f: `EmailClient` warns at synth when `fromAddress` is on a reserved domain that SES can never verify, such as `example.com` or anything under `.test`. The demo template's sender is an `EMAIL_SENDER` constant, which you replace with a verified SES identity before deploying to production.
- da1e2a5: `send()` and `sendBatch()` reject a subject that contains CR, LF, or another control character with `InvalidInputException`, locally and when deployed. In `sendBatch()` the entry is marked `failed` and not sent.
- 8e96367: `bb-agent` reports an unexpected error to the client as `Internal error` instead of the raw backend text, and `bb-email-client` `send()` errors have stable messages per `EmailErrors` code. The message of an `ApiError` or a branded Building Block error still reaches the client unchanged.

## 0.2.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

- 3142985: **Breaking: the deployed `EmailClient` validates addresses before calling SES, and the shared execution role is granted only `ses:SendEmail` and `ses:SendBulkEmail`.**

  To upgrade:

  1. Handle `InvalidInputException` from `send()`, and `failed` results from `sendBatch()`, for addresses that SES accepted but the validator rejects, such as quoted local parts or non-ASCII domains.
  2. If your app calls the SES SDK directly and relied on this block's grant of `ses:SendRawEmail`, `ses:SendTemplatedEmail`, or `ses:SendBulkTemplatedEmail`, grant those actions yourself.

  `sendBatch()` sends a message without `html` as plain text only, as `send()` already does.

### Patch Changes

- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- 48c35f6: The `cdk` and `browser` entry points export the names they were missing, so importing them during `cdk synth` or in a browser bundle no longer fails. The `browser` entries add the error constants `AgentErrors`, `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 27c35e5: The docs state that `Secret` reads pick up rotated values after `cacheTtlSeconds`, not only on cold start, and that `EmailClient` validates recipient and size limits on AWS too. Other fixes cover the `useChat` anchor, `Pipeline` connection ARN examples, and the `KnowledgeBase` mock's chunking.
- 2f59ce5: `DESIGN.md` describes the infrastructure the block creates. It no longer lists an SES configuration set or SES email identity, and it states the prerequisites of a verified sender identity and SES production access.
- ea57feb: Corrects three JSDoc comments. The `EmailErrors` example passes `send()` a single message object, `Secret` examples that call `put()` pass `allowRuntimeWrite: true`, and an omitted `FileBucket` `removalPolicy` inherits the stack's `BlocksDefaults.removalPolicy`.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.1.9

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.

## 0.1.8

### Patch Changes

- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.1.7

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.

## 0.1.6

Dependency updates only.

## 0.1.5

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

- c0558f3: Minor improvements

## 0.1.0

Initial version
