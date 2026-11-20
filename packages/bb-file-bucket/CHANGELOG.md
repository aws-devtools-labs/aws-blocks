# @aws-cdk-blocks/bb-file-bucket

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-file-bucket` 0.x

- The package is now `@aws-cdk-blocks/bb-file-bucket`. Install it in place of `@aws-blocks/bb-file-bucket`, and change the import specifiers.
- 7c23ab9: Upload URLs carry signed constraints, download disposition is opt-in, key validation is stricter, and invalid input returns 400.
- 072c3ff: An unrecognized `encryption` value on `KVStore` or `FileBucket` fails the synth instead of falling back to the default key.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that no method throws `FileBucketErrors.FileNotFound` or `FileTooLarge`. `get()` returns `null` for a missing file, and an upload over `maxUploadBytes` throws `ValidationFailed`.

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

- 7c23ab9: **Breaking: `putUrl()` and `createUploadHandle()` always sign a `Content-Type`, which is `application/octet-stream` when you pass no `contentType`.**

  To upgrade:

  1. Pass to `putUrl()` the `contentType` the client will send, or send `Content-Type: application/octet-stream` with the upload.
  2. Pass `contentType: file.type` to `createUploadHandle()` to keep storing the browser's file type.
  3. Allow `Content-Type` in the `allowedHeaders` of your `corsRules`.

  Also adds the `contentLength`, `attachment`, `allowedContentTypes`, and `maxUploadBytes` options, validates keys more strictly, and answers `ValidationFailed` with HTTP 400 instead of 500.

- 072c3ff: An unrecognized `encryption` value on `KVStore` or `FileBucket` fails the synth instead of emitting an `UnknownEncryption` warning and falling back to the AWS-managed key. If you hit the error, correct the value.

### Patch Changes

- c67048e: **Breaking: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block, and `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data`, and `@aws-blocks/data-common` are removed.**

  To upgrade:

  1. Import `Database`, `DatabaseCluster`, `DatabaseErrors`, and `sql` from `aws-cdk-blocks`.
  2. To keep an old `@aws-blocks/bb-data` cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it.
  3. Replace `DistributedDatabase` with a `Database` of the same id, which keeps its cluster.
  4. Replace `Database.fromExisting()` with `DatabaseCluster.fromExisting()`, passed as `cluster`.
  5. Replace `withRLS()` with `asUser()` or `asRole()`, and use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely` for Kysely.
  6. Store the connection string of an existing database with `npm run db -- connect --stage <stage>`, not a `*_DB_URL` or `*_CONNECTION_STRING` environment variable.

  Data is not moved, and `crud()`, `ensureSecrets`, and the `npm run db` commands `pull` and `generate-types` are removed.

- e8e3262: Brand the `ValidationFailed` error thrown for an invalid object key so its name and message reach RPC clients instead of a generic internal error.
- eacc87e: Local file server now returns 404 `NoSuchKey` for presigned GETs of a versioned key whose current version is a delete marker, matching S3 and `get()`.
- 94d5900: The production settings of `FileBucket` live in a `PRODUCTION.md` next to the block's `README.md`, which links to it. It covers access logging, KMS encryption, Object Lock, scaling, and cost.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 9d69412: The docs state that session cookies default to `SameSite=Lax`, that an `inferenceOnly` agent still creates its S3 session bucket, and that `objectLock` can be added to a deployed `FileBucket` as an in-place update.
- d01c34c: The FileBucket README's access-control examples construct `new Auth(scope, 'auth')` instead of the removed `AuthBasic`. For frontend code and tests, the scaffolded `AGENTS.md` says to import `ApiError` and `isBlocksError` from `aws-cdk-blocks/client`.
- 0ff1e1f: The FileBucket design doc describes the installed version. The versioning, bucket-name, and access-log decisions describe today's defaults.
- 8fb67ec: Deleting the newest stored version in a local FileBucket makes the next stored version the current body and metadata, or removes the current copies when none remain.
- 11877b6: The FileBucket docs state that `get()` always downloads the whole body and is the only call that returns `contentType` and `metadata`. `scan()` returns `size` and `lastModified` without the body.
- 77c2c75: The README has a new "Changing Metadata" section. FileBucket object metadata is set when the object is written, each `put()` replaces it, and a `put()` without `metadata` leaves none.
- f643a76: Return HTTP 404 for local presigned downloads of unknown or permanently deleted file versions instead of serving the current file's content.
- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.

## 0.4.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- 9c96135: Adds `encryption` and `objectLock` options to `FileBucket`, and `BlocksDefaults.storageAccessLogging` for S3 server access logging on every `FileBucket`. With Object Lock, `putUrl()` and `createUploadHandle()` throw `FileBucketErrors.PresignedUploadUnsupported`, so upload with `put()`.

### Patch Changes

- ee69cd7: The docs say that `corsRules` is required for browser uploads and downloads. Without it, uploads and downloads that work under `npm run dev` fail after you deploy to a sandbox or production stack.
- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- 943d405: The `cdk` entry of `@aws-blocks/bb-file-bucket` exports the types that were missing from it, such as `FileVersionInfo`, `FileDownloadClient`, and `FileUploadClient`, so backend code that imports them type-checks.
- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- 48c35f6: The `cdk` and `browser` entry points export the names they were missing, so importing them during `cdk synth` or in a browser bundle no longer fails. The `browser` entries add the error constants `AgentErrors`, `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 0ee86e1: `getUrl`, `putUrl`, and upload and download handles reject expiration values that are not whole seconds between 1 and 604800 with `ValidationFailed`.
- 48c35f6: `FileBucket` no longer fails `cdk synth` when its derived S3 bucket name is longer than 63 characters. It shortens such a name to the start of the name plus `-` and an 8-character hash, and names that already fit are unchanged.
- ea57feb: Corrects three JSDoc comments. The `EmailErrors` example passes `send()` a single message object, `Secret` examples that call `put()` pass `allowRuntimeWrite: true`, and an omitted `FileBucket` `removalPolicy` inherits the stack's `BlocksDefaults.removalPolicy`.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.3.1

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.

## 0.3.0

### Minor Changes

- 1f8a412: **Breaking: on AWS, FileBucket now rejects invalid object keys with `ValidationFailed`, as it already did in local dev.** A key is invalid when it is empty, has a leading slash, or contains an empty path segment, ASCII control characters, or a `..` or `.` path segment. If your app already stored objects under such keys, re-key those objects before upgrading.

### Patch Changes

- fa0406b: Moves the synth-time option guards of `FileBucket` into a shared `validation.ts` that the CDK and mock constructors both call, with no behavior change.
- 251aed2: On AWS, `get()` returns `null` and `delete()` is a no-op for an unknown `versionId`, as in the mock. `restoreVersion()` throws the new `FileBucketErrors.VersionNotFound`.
- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.2.1

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.

## 0.2.0

### Minor Changes

- 1b66571: **Breaking: `FileBucket` turns versioning on by default, removes the `logRetentionDays` option, and rejects a wildcard CORS origin with a mutating method at synth.**

  To upgrade:

  1. Set `versioned: false` on a bucket that must stay non-versioned, because versioned buckets keep noncurrent versions for `noncurrentVersionExpirationDays` days, `90` by default.
  2. Remove `logRetentionDays`, because access-log retention now follows `BlocksDefaults.logRetention`.
  3. Give explicit origins to any CORS rule that combines `'*'` with `PUT`, `POST`, or `DELETE`.

  Every provisioned bucket also sets `enforceSSL: true`, and an omitted `removalPolicy` falls back to `BlocksDefaults.removalPolicy`.

## 0.1.5

### Patch Changes

- 309a236: Data and auth blocks grant permissions to the shared Blocks execution role instead of the handler function. The effective runtime permissions are identical.

## 0.1.4

Dependency updates only.

## 0.1.3

### Patch Changes

- bd59e60: The local dev file server serves downloads with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, so an uploaded `text/html` or SVG file no longer runs inline. A per-process random value replaces the hardcoded HMAC secret that signs presigned-URL tokens.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
