# @aws-cdk-blocks/bb-kv-store

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-kv-store` 0.x

- The package is now `@aws-cdk-blocks/bb-kv-store`. Install it in place of `@aws-blocks/bb-kv-store`, and change the import specifiers.
- 072c3ff: An unrecognized `encryption` value on `KVStore` or `FileBucket` fails the synth instead of falling back to the default key.
- c672712: Add a `consistentRead` option to `get()`.
- 6d3077e: `KVStore` is the only key-value block: `DistributedTable` is folded in. A store of release 0.4.0 or earlier needs `LegacyKVStore`. See "Upgrade from release 0.4.0 or earlier" in the `bb-kv-store` README.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that there is no atomic increment, and the conditional-writes section shows two ways to keep a concurrent counter. The transaction pointer names `transaction()` on `Database`.

## 1.0.0-rc.1

### Patch Changes

- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- e529b00: A sandbox table that the index manager recreates keeps its encryption key, TTL, tags, point-in-time recovery, stream, and table class, and a `protection: 'locked'` table is no longer deleted. A key from `KVStore.fromKmsKey()` must allow the index manager's role in its key policy.
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

- 072c3ff: An unrecognized `encryption` value on `KVStore` or `FileBucket` fails the synth instead of emitting an `UnknownEncryption` warning and falling back to the AWS-managed key. If you hit the error, correct the value.
- c672712: `KVStore.get` accepts an optional second argument, `{ consistentRead }`. `get` is strongly consistent by default, so pass `{ consistentRead: false }` where a stale value is acceptable.

- 6d3077e: **Breaking: `KVStore` takes over the data model of `DistributedTable`, and the `@aws-blocks/bb-distributed-table` package is removed.**

  To upgrade:

  1. Replace a `DistributedTable` with `new KVStore(scope, id, { schema, key, indexes, ttl })`, which keeps the table in place.
  2. Change `put(item)` to `put({ pk: item.pk, sk: item.sk }, item)` and `putBatch([item])` to `putBatch([{ key, value: item }])`.
  3. Change `for await (const item of table.query(o))` to `for await (const { value: item } of store.query(o))`.
  4. Change `DistributedTableErrors` to `KVStoreErrors`.
  5. On an existing `KVStore`, drop `ttl: true`, replace `removalPolicy`/`deletionProtection` with `protection`, and replace `ifValueEquals` on an object value with `ifFieldEquals`.
  6. For an existing `KVStore` table, destroy the stack and deploy again in a sandbox, or follow the README section "Upgrade from release 0.4.0 or earlier" for data you must keep.

  A deployed `KVStore` table cannot stay in place because the stored item format changed, and the mock converts local data the first time it loads it.

### Patch Changes

- a5a5dd3: `KVStore` rejects more malformed input with `KVStoreErrors.InvalidQuery`, the same way locally and on AWS. That covers a `query()` `order` other than `'asc'` or `'desc'`, and an `indexes` option given as an array.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 99638ca: The `KVStore` README states that the whole key, the partition field plus the sort field, is the identity of an item. It also says how to make a field unique in the whole store and list grouped items from an index.
- a5f39c3: The docs describe the status 409 of a failed `KVStore` condition, the local data files of `KVStore` and `AppSetting`, and how a `RawRoute` fills `params` under `npm run dev`.
- d01c34c: The docs state that a conditional KVStore `put` or `delete` is atomic for its item, with no transaction across items. They also cover what `withAuth` detects, the test helpers in `aws-cdk-blocks/utils`, and the dev server's error responses in `TROUBLESHOOTING.md`.
- d01c34c: The README and `DESIGN.md` state that a KVStore index query returns whole items. They also state that DynamoDB rejects a `put` whose indexed field holds `null` with a `ValidationException`, while the local mock accepts the write.
- 5f55dac: Docs and editor hover text point at `Auth` instead of the removed `AuthBasic`, `AuthCognito`, and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table.
- d1a473f: The `encryption` docstring states that the dedicated KMS key of a `'disposable'` table is scheduled for deletion with the table. Each public `KVStore` method has an `@example`, and the `LegacyKVStore` docs say what the class has.
- 92798e1: `KVStore` rejects calls that DynamoDB rejects, the same way locally and on AWS, with `KVStoreErrors.InvalidQuery` or `KVStoreErrors.ValidationFailed`. Code that matched DynamoDB's `ValidationException` should match the `KVStoreErrors` names instead.
- 92798e1: The local `KVStore` stores and returns copies of items, so changing an object after `put()` no longer changes what the next read returns. Values that DynamoDB can't store, such as an empty `Set`, a `Date`, or `NaN`, fail locally as they do on AWS.
- 836af43: Adds `LegacyKVStore`, a deprecated class that keeps the table of a `KVStore` from release 0.4.0 or earlier usable while you move its data to a new `KVStore`. The README section "Upgrade from release 0.4.0 or earlier" has the steps.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

## 0.4.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- 943d405: The `cdk` entry of `@aws-blocks/bb-kv-store` exports `ScanOptions`, so backend code that imports it type-checks.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 92c4b20: The README "Runtime only" note states that a data method called during CDK synth throws `<Class>.<method>() cannot be called during CDK synth`.
- 0d4ede3: `bb-kv-store` and `bb-distributed-table` share one internal helper in `@aws-blocks/core` for point-in-time-recovery and encryption resolution. The synth output is unchanged.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.3.1

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.
- 023f02c: An internal refactor routes the remaining per-package errors through core's `blocksError`. Two realtime timeout rejections that were unbranded are now wire-safe.
- 32a4b73: `AuthOIDC` is reported as the parent block of its session store, and `core` adds the `computeScopeFullId` and `buildingBlockParent` exports. In local and other non-Lambda runs the session cookie name changes, for example to `oidc_my-app-auth`, so existing sessions there are signed out once.

## 0.3.0

### Minor Changes

- 20be3f0: `KVStore` honors `defaults.pointInTimeRecovery` and defaults to the `aws/dynamodb` KMS key instead of the AWS-owned key, so the next deploy updates tables in place and adds charges. Remove `removalPolicy`, `deletionProtection`, and `ttl` from `fromExisting()` calls, or `cdk synth --strict` fails.

### Patch Changes

- 5454763: On AWS, `delete(key, { ifValueEquals: undefined })` no longer fails with a marshalling error, and `delete()` applies both `ifExists` and `ifValueEquals` when both are set. Both cases match the mock.
- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.2.0

### Minor Changes

- 81609a8: `KVStore.put` accepts `ifNotExists` and `ifValueEquals` together. The write succeeds when the key is absent or its current value matches.
- 21443ba: Optimistic-concurrency and conditional-write conflicts reach clients as JSON-RPC error code 409 instead of 500. Code that matches conflicts by name with `isBlocksError` is unaffected, but code that branched on `error.status === 500` now sees `409`.

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.

## 0.1.8

Dependency updates only.

## 0.1.7

### Patch Changes

- 309a236: Data and auth blocks grant permissions to the shared Blocks execution role instead of the handler function. The effective runtime permissions are identical.

## 0.1.6

### Patch Changes

- 7b4c62d: **Breaking: `BlocksStack.create` and `BlocksBackend.create` require a `defaults` field.** Pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`, which replaces the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin. A per-block option still wins over `defaults`. The experimental `hardening` prop is removed with its `resolve*` helpers.

## 0.1.5

### Patch Changes

- b83aaba: Adds opt-in TTL to `KVStore` with the `ttl` construct option and `put(key, value, { ttlSeconds })` or `{ expiresAt }`. `AuthCognito` uses it for session records, so your next `cdk deploy` enables TTL on the existing sessions table, and only sessions written after the upgrade expire.

## 0.1.4

### Patch Changes

- 683bf49: The `test` script finds tests with the `dist/*.test.js` glob, so the user-agent suite runs in CI.

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
