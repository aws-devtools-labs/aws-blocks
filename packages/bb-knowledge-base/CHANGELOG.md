# @aws-cdk-blocks/bb-knowledge-base

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since `@aws-blocks/bb-knowledge-base` 0.x

- The package is now `@aws-cdk-blocks/bb-knowledge-base`. Install it in place of `@aws-blocks/bb-knowledge-base`, and change the import specifiers.
- d51b8ee: Add `KnowledgeBase.asAgentTool()`, which returns a search tool for an Agent's `tools` callback.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- 6b1086b: The `Agent` and `KnowledgeBase` READMEs are corrected and reorganized. Model presets and Bedrock access for `Agent` moved to `MODELS.md`, which ships in the package.

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

- d51b8ee: Adds `KnowledgeBase.asAgentTool()`, which returns a search tool for an Agent's `tools` callback. A required `filter` callback derives the metadata filter from the per-call tool context, and the tool is marked `untrustedOutput: true`.

### Patch Changes

- 5f55dac: Docs and editor hover text point at `Auth` instead of the removed `AuthBasic`, `AuthCognito`, and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table.
- 0ff1e1f: The KnowledgeBase docs state that `isSynced()` returns `true` without an ingestion job when the handler config has no data source id.
- 287be20: `IngestionFailedException` from `isSynced()` and `waitUntilSynced()` has a fixed message, and Bedrock's `failureReasons` go to the server log and the error's `cause`. If your server code read the reasons from `err.message`, read `failureReasons` from `err.cause` instead, and treat it as optional.
- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

## 0.3.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- d1d129f: Adds `untrustedOutput: true` for a tool, so the model treats the result as data, and a `guardrail` option on a Bedrock `ModelConfig` that attaches an Amazon Bedrock guardrail. `ModelConfig.guardrails` is deprecated because no provider ever applied it, and the agent logs a warning when it is set.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 27c35e5: The docs state that `Secret` reads pick up rotated values after `cacheTtlSeconds`, not only on cold start, and that `EmailClient` validates recipient and size limits on AWS too. Other fixes cover the `useChat` anchor, `Pipeline` connection ARN examples, and the `KnowledgeBase` mock's chunking.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.6

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.
- 023f02c: An internal refactor routes the remaining per-package errors through core's `blocksError`. Two realtime timeout rejections that were unbranded are now wire-safe.
- 2be3318: Test-only change. The `bb-knowledge-base` CDK test stub grants through the shared `executionRole` like the Building Block does.

## 0.2.5

### Patch Changes

- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.2.4

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.

## 0.2.3

### Patch Changes

- 64ddd74: The CDK tests call `finalizeConfigRegistry` with its new `(root, executionRole, computes)` signature, a test-only change.

## 0.2.2

### Patch Changes

- 309a236: Data and auth blocks grant permissions to the shared Blocks execution role instead of the handler function. The effective runtime permissions are identical.
- de4f209: `KnowledgeBase.retrieve` rejects a fractional or non-finite `maxResults` with `KnowledgeBaseErrors.ValidationError` in both the mock and AWS runtimes, before any search or Bedrock request.

## 0.2.1

### Patch Changes

- 7b4c62d: **Breaking: `BlocksStack.create` and `BlocksBackend.create` require a `defaults` field.** Pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`, which replaces the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin. A per-block option still wins over `defaults`. The experimental `hardening` prop is removed with its `resolve*` helpers.
- edbf1aa: The ingestion custom resource sets `installLatestAwsSdk: false`, which removes roughly 15-30s of cold start from the provider Lambda. Expect one ingestion job to start on the first deploy after upgrading.

## 0.2.0

### Minor Changes

- b6fb281: Adds `isSynced()` and `waitUntilSynced()` to KnowledgeBase, which tell whether the data source's most recent ingestion job is complete. `waitUntilSynced()` polls until synced and throws `KnowledgeBaseTimeoutException` on timeout or `IngestionFailedException` on a failed job.

### Patch Changes

- b6fb281: On a `removalPolicy: 'destroy'` or sandbox teardown, the S3 Vectors bucket and index are deleted alongside the data bucket instead of being left behind. Otherwise they are retained.

## 0.1.3

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.
- f24d3c3: Bedrock `ValidationException`s that are not filter-related surface as `KnowledgeBaseValidationError` instead of `InvalidFilterException`. If you catch `InvalidFilterException` to handle generic query-validation failures, add handling for `KnowledgeBaseValidationError`.

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
