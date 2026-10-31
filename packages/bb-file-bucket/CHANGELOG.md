# @aws-blocks/bb-file-bucket

## 0.4.0

### Minor Changes

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

- 9c96135: feat(bb-file-bucket): customer-managed KMS encryption, Object Lock, and a stack-wide default for S3 access logging

  - **`encryption`** on `FileBucket` takes the same values as `KVStore` and `DistributedTable`. `'aws-managed'` (the default) keeps SSE-S3. `'customer-managed'` creates a dedicated KMS key for the bucket, with rotation on, and removes it along with the bucket. `FileBucket.fromKmsKey(arn)` uses a key you already own. Both KMS options use S3 Bucket Keys. The runtime role is granted the key permissions, so `put`/`get` and presigned URLs keep working.
  - **`objectLock: { mode: 'governance' | 'compliance', retentionDays }`** turns on S3 Object Lock with a default retention for every new object version. It needs versioning (on by default) and a retained bucket, and both are checked at synth: `versioned: false` and a `'destroy'` removal policy, which is the sandbox default, both fail synth. Pass `removalPolicy: 'retain'` to use Object Lock in a sandbox. Object Lock can only be turned on when the bucket is first created. S3 requires a signed checksum on every upload to such a bucket, which a presigned URL can't carry, so `putUrl()` and `createUploadHandle()` throw the new `FileBucketErrors.PresignedUploadUnsupported` there; upload with `put()`.
  - **`BlocksDefaults.storageAccessLogging`** (optional) turns S3 server access logging on or off for every `FileBucket` without changing API Gateway access logging. It is unset in both presets, so `FileBucket` still falls back to `accessLogging` and existing stacks deploy unchanged.

  `encryption` and `objectLock` are ignored on a bucket wrapped with `FileBucket.fromExisting`, and synth warns when either is set there. `@aws-blocks/blocks` re-exports `ObjectLockOptions` and the FileBucket key reference type, as `FBExternalKmsKeyRef`.

  `@aws-blocks/core` now parses the `encryption` option in one place for all three storage blocks. An unrecognized value still warns and falls back to the AWS-managed default.

### Patch Changes

- ee69cd7: docs(bb-file-bucket): document that `corsRules` is required for browser uploads and downloads

  Browser uploads and downloads that worked under `npm run dev` failed after
  deploying to a sandbox or production stack with `No 'Access-Control-Allow-Origin'
header is present on the requested resource`, and nothing in the docs explained
  why. The local dev file-server accepts any origin, but the deployed S3 bucket has
  no CORS configuration unless `corsRules` is set — and it does not inherit the
  stack's `defaults.allowedOrigins` or the Hosting domain.

  - **bb-file-bucket README** — new "Browser Uploads and Downloads (CORS)" section
    with the failing error, a working `corsRules` example (`GET`/`PUT`,
    `allowedHeaders: ['Content-Type']`), how to find the deployed Hosting origin
    (`HostingUrl`), and notes on preflight headers, S3 origin syntax, the scope of
    the wildcard synth guard, which requests need CORS, and wrapped buckets. The
    `corsRules` option row, Best Practices, and Local Development sections now
    point to it.
  - **bb-file-bucket TSDoc / DESIGN.md** — `corsRules` documents its no-CORS
    default, that it is ignored for wrapped buckets, and (new D-FB-15) why it is
    not derived from `defaults.allowedOrigins` or the Hosting domain.
  - **blocks README** — the Security Considerations list notes that
    `defaults.allowedOrigins` covers the API only and FileBucket needs its own
    `corsRules`.

  Documentation only — no runtime or API change.

- 943d405: fix: error constants can be imported in frontend code

  Frontend code imports a Building Block's error constants to match errors with `isBlocksError`, which resolves the
  package's `browser` entry. Some of those imports failed the frontend build:

  - `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors` were missing from the `browser` entries
    of `@aws-blocks/bb-app-setting`, `@aws-blocks/bb-email-client`, `@aws-blocks/bb-file-bucket`, and
    `@aws-blocks/bb-logger`. They are now exported.
  - Any import from `@aws-blocks/bb-auth-basic` or `@aws-blocks/bb-auth-cognito`, including `AuthBasicErrors` and
    `AuthCognitoErrors`, failed with `No matching export ... for import "ApiNamespace"`. The browser stubs no longer
    depend on `ApiNamespace`; their server-only `createApi()` / `buildApi()` now throw if called in the browser.
  - `CronJobErrors.ScheduleNotSupported` was `undefined` in the browser, so `isBlocksError(e, CronJobErrors.ScheduleNotSupported)`
    never matched. The `@aws-blocks/bb-cron-job` and `@aws-blocks/bb-dashboard` browser entries now re-export the
    server's constants instead of keeping their own copies.
  - `@aws-blocks/bb-realtime` had no `browser` entry, so importing `RealtimeErrors` in frontend code pulled in the
    server build and failed to bundle. It now has one.

  `@aws-blocks/blocks`: the conditional-export parity test now checks that every Building Block with error constants
  has a `browser` entry that exports them with the same values, and that the entry bundles for the browser.

- 943d405: fix: export types missing from the `cdk` entry point

  Some types exported by the default entry point of `@aws-blocks/bb-file-bucket` were missing from its `cdk` entry, so
  backend code importing them failed to type-check under that condition — for example,
  `import type { FileVersionInfo } from '@aws-blocks/bb-file-bucket'`.

  The `cdk` entry now exports `FileDownloadClient`, `FileUploadClient`, `FileVersionInfo`, `FileDownloadDescriptor`,
  `FileUploadDescriptor`, `VersionedGetOptions`, `VersionedDeleteOptions`, `VersionedGetUrlOptions`, `GetOptionsFor`,
  `DeleteOptionsFor`, `GetUrlOptionsFor`.

- a3969b5: fix: actionable errors for runtime methods called during `cdk synth`

  Calling a Building Block's runtime method (for example `db.query()`, `bucket.put()`, `auth.requireAuth()`, or
  `auth.admin`) at the top level of a backend module runs it during `cdk synth`. For many Building Blocks this failed with
  a cryptic `TypeError: x is not a function`; it now throws the same actionable error the other Building Blocks already
  give: `<Class>.<method>() cannot be called during CDK synth. Data methods run at request time — …`.

- 48c35f6: fix: export the same names from every conditional entry point

  Some Building Blocks were missing named exports from their `cdk` or `browser`
  entry points, even though the TypeScript types said they were there. Importing
  one of these names from code evaluated during `cdk synth`, or from a browser
  bundle, failed at import time. Added:

  - `cdk` entry: `InterruptError` (`@aws-blocks/bb-agent`), `BatchSubmitFailedError`
    (`@aws-blocks/bb-async-job`), and `RLSEnabledDatabase` and `PgClientEngine`
    (`@aws-blocks/bb-data`).
  - `browser` entry: the error constants `AgentErrors`, `AppSettingErrors`,
    `EmailErrors`, `FileBucketErrors` and `LoggingErrors` (for `isBlocksError` checks
    in frontend code), plus `InterruptError`, `BedrockModels` and `OllamaModels`
    (`@aws-blocks/bb-agent`) and `fromExisting` (`@aws-blocks/bb-data`).

  The conditional-exports regression test now compares every Building Block's
  `aws-runtime`, `cdk` and `browser` entries against its default entry in both
  directions, so these gaps can't come back unnoticed.

- d366907: chore: manual dependency bump (2026-10-19)
- 0ee86e1: Validate presigned URL expiration values before creating local tokens or AWS signatures. `getUrl`, `putUrl`, and upload/download handles now reject values that are not whole seconds between 1 and 604800 with `ValidationFailed`, matching Signature Version 4 requirements.
- 48c35f6: `FileBucket` no longer fails `cdk synth` when its derived S3 bucket name is longer than 63 characters. A bucket's name comes from your stack name and scope ids, so a long stack name or deeply nested ids could push it over S3's limit. This also hit blocks that create a bucket internally, such as `Agent`. These names are now shortened to the start of the name plus `-` and an 8-character hash. The result is the same on every deploy, and different scope chains still get different names. Bucket names that already fit are unchanged, so no existing bucket is renamed or replaced. Names that break any other S3 naming rule still fail synth with `ValidationFailed`.
- ea57feb: Correct JSDoc: the `EmailErrors` example now calls `send()` with a single message object, `Secret` examples that call `put()` now pass `allowRuntimeWrite: true`, and the `FileBucket` `removalPolicy` docs now say an omitted policy inherits the stack's `BlocksDefaults.removalPolicy`.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [943d405]
- Updated dependencies [50b8c94]
- Updated dependencies [a3969b5]
- Updated dependencies [48c35f6]
- Updated dependencies [ce5dfa9]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [9a32674]
- Updated dependencies [48c35f6]
- Updated dependencies [8c73a24]
- Updated dependencies [48c35f6]
- Updated dependencies [4553866]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [54e9443]
- Updated dependencies [48c35f6]
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [9c96135]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [515089c]
- Updated dependencies [dde6340]
- Updated dependencies [7477b6e]
- Updated dependencies [6a53068]
- Updated dependencies [dd5e807]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [48c35f6]
  - @aws-blocks/core@0.8.0
  - @aws-blocks/bb-logger@0.3.0

## 0.3.1

### Patch Changes

- 92fa27b: Internal: route named-error minting through `@aws-blocks/core`'s `blocksError`. No behavior change.
- Updated dependencies [ec7eebe]
- Updated dependencies [e682ba7]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8a1a4a9]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [b8649dc]
- Updated dependencies [2da2fd4]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [7c19c4f]
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-logger@0.2.2

## 0.3.0

### Minor Changes

- 1f8a412: FileBucket now validates object keys identically in local dev and on AWS. A key is rejected (`ValidationFailed`) on both paths when it is empty, has a leading slash, contains an empty path segment (interior `a//b` or trailing `a/`), contains ASCII control characters, or contains a `..`/`.` path segment. Previously this validation ran only in the local mock, so such a key was silently accepted on the AWS runtime.

  Behavior change: the AWS runtime previously performed no key validation, so these keys were accepted. After upgrading, `get`/`delete`/`listVersions`/`restoreVersion` and the URL/batch methods reject them. If an application already stored objects under such keys, re-key those objects before upgrading.

### Patch Changes

- fa0406b: Refactor: extract FileBucket's synth-time option guards (unsafe-CORS wildcard, `noncurrentVersionExpirationDays` format) into a shared `validation.ts` (`validateFileBucketOptions`) called by both the CDK and mock constructors. Previously each constructor carried a verbatim copy of the guards; a single source of truth keeps mock↔CDK parity from drifting. No behavior change — the same combinations are rejected with identical messages on both paths. Follows the `bb-app-setting` pattern (#584); refs #590.
- 251aed2: fix(bb-file-bucket): align unknown-`versionId` behavior between the mock and AWS

  On a versioned bucket, an unknown `versionId` diverged between runtimes. S3 does
  **not** signal an unknown `versionId` as `NoSuchVersion` (verified against real
  S3): an id it cannot resolve comes back as `InvalidArgument` ("Invalid version id
  specified") on `GetObject`/`DeleteObject` and `InvalidRequest` on `CopyObject`;
  `NoSuchVersion` is reserved for a well-formed id that no longer exists. The AWS
  runtime now normalizes all of these so the observable contract matches the mock:

  - `get()` — returns `null` for an unknown `versionId` (matching the mock and
    `get()`'s documented "null if it does not exist" contract), instead of throwing.
  - `delete()` — is a silent no-op for an unknown `versionId` (matching the mock),
    instead of throwing.
  - `restoreVersion()` — throws a clean, matchable `FileBucketErrors.VersionNotFound`
    (`NoSuchVersion`) via core's `blocksError` producer, so both `.name`
    (`isBlocksError(e, FileBucketErrors.VersionNotFound)`) and the `.message` agree
    across runtimes — instead of the raw S3 error, whose enumerable `$metadata`
    (request IDs, ARNs) would leak to the client on serialization.

  The raw S3 codes are folded only when a `versionId` was actually supplied, so an
  unrelated `InvalidArgument`/`InvalidRequest` still surfaces. Also adds the public
  `FileBucketErrors.VersionNotFound` constant, and encodes the caller-supplied
  `versionId` in `CopySource` (a value with `&`, `#`, `?`, or a space would
  otherwise corrupt the `x-amz-copy-source` header).

- 757d4a9: feat(core): forward the native client user-agent into the AWS SDK user agent

  Native runtimes send `x-blocks-user-agent: aws-blocks-<lang>/<version>` on the RPC
  request. `@aws-blocks/core` validates it against a strict grammar (length-capped,
  dropped silently when malformed), carries it per request in an `AsyncLocalStorage`,
  and exports `installClientUserAgent`, an SDK middleware that appends the validated
  token to the outgoing user agent. The 12 participating Building Blocks install it,
  so native attribution rides the SDK user-agent chain AWS service telemetry already
  counts. The Kotlin runtime already sends the header, so Kotlin
  callers are attributed as soon as this ships; Swift and Dart follow.

- a23b8d8: Stop leaking raw backend exception details in RPC error responses, while forwarding Building Block error names AND their BB-authored messages.

  `errorResponseFromCatch` sorts a caught throw into three cases: an `ApiError` crosses the wire verbatim (status, `message`, `name`, `retriable`); a Building Block error carrying the wire-safe brand forwards BOTH its BB `name` in `data.name` AND its BB-authored `message` (per D-003, the wire carries `name` alongside `message`), so `isBlocksError()` keeps matching on the client and the caller sees the real, actionable message ("Batch contains 150 payloads, exceeds the 100 limit"); and everything else — a driver/SDK exception, a bare `Error`, or a non-`Error` throw — collapses to a nameless generic `500` / `"Internal error"`. The full error (including `cause`) is still logged server-side in every case.

  The brand is a non-enumerable symbol stamped by core's new `brandBlocksError()` helper, and the serializer keys the name-and-message-forwarding decision on that brand rather than on `.name !== 'Error'`. Every Building Block that mints a named error now routes it through that one helper — core's `blocksError()`, each package's own local `blocksError()`, and the inline named-error sites across the runtime and mock layers — so a BB error keeps its `name` and message on the wire no matter which package or layer threw it. A raw driver exception whose class name happens to be non-generic (`PostgresError`, `DynamoDBServiceException`) is never branded, so neither its class name nor its raw message ever reaches the client.

  The load-bearing invariant, now that messages cross the wire: **a branded error's message must never embed raw driver/SDK text.** Two message-embedding sites are therefore given stable, BB-authored messages (`bb-kv-store` and `bb-distributed-table`'s item-too-large remaps, which previously copied DynamoDB's raw `err.message`), keeping the raw driver error only as `cause`.

  Re-tag paths are branded, with a stable message. The catch-all re-tag paths in `bb-data` (`wrapError` / `translatePgError`) and `bb-distributed-data` (`translateDsqlError`) — which classify a caught driver error as `QueryFailed` / `ConnectionFailed` — now build a fresh BRANDED error carrying the BB `name` and a stable BB message (e.g. "The database query failed"), keeping the raw driver error as `cause`. This preserves the client-side `isBlocksError(e, DatabaseErrors.QueryFailed | .ConnectionFailed)` retry contract the `bb-data` README teaches for auto-pause-resume, and — because the message is a stable BB string, not the driver's — a re-tagged error still never leaks driver internals over the wire. The 40001 / 23505 conflict paths already crossed as `ApiError` (409) with stable messages and are unchanged. Also branded in this pass: `bb-auth-oidc`'s `InvalidRelayError` (a class-field error not reached by the `.name =` sweep) and `bb-distributed-data`'s mock DDL-guard error (name `DsqlPermissionException`, the internal `DSQL_PERMISSION_ERROR_NAME`; now branded with a stable message, its name kept internal and mock-only, not a public `DistributedDatabaseErrors` constant).

  The two `bb-realtime` client-middleware `brandBlocksError` calls are commented as intentionally inert (a client-side subscription rejection matches on `err.name`, never routes through the server serializer). The realtime e2e's `ConnectionFailedException` assertions run against `channel.subscribe()` in-process on the client, not across the RPC serializer.

  ## Breaking change (why `@aws-blocks/core` is a minor)

  App code that throws a plain `Error('Todo not found')` from an API method now surfaces as a generic `500` / `"Internal error"` on the client instead of the raw message (a customer-defined `Error` also loses its `.name`). This is the intended safety net — an unbranded throw is treated as an unhandled internal error — but it changes client-visible behavior, so `@aws-blocks/core` ships as a minor (we are pre-1.0). To send a specific status, name, and message to the client, throw an `ApiError`:

  ```ts
  // before — message collapses to "Internal error" on the client
  throw new Error("Todo not found");

  // after — status, message, and name all reach the client
  throw new ApiError("Todo not found", 404, { name: "TodoNotFoundException" });
  ```

  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.

- Updated dependencies [5501cb6]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [5515483]
- Updated dependencies [757d4a9]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-logger@0.2.1

## 0.2.1

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
- 6496713: feat(core): constructor-forced VPC requirements, lazy VPC, and Database subnet control

  Continues the VPC review follow-ups (net-new, unreleased VPC feature).

  **Building Blocks declare VPC requirements via the constructor, not a method.**
  `BuildingBlockScope` is no longer abstract: its constructor takes the block's VPC
  requirements (a value, or a callback for values that depend on `fullId`) and
  registers them in a central per-stack registry. This keeps the compile-time
  forcing the previous `abstract getVpcRequirements()` provided — a block can't
  silently omit its requirements — without a standing method on every subclass, and
  gives the framework one place to read, deduplicate, and answer "does anything here
  need a VPC?". All Building Blocks were migrated to pass requirements to `super()`.

  **VPC is now a derived resource, not a hard prerequisite.** A block that cannot
  function without a VPC declares `requiresVpc: true`; when one is needed and the
  customer didn't bring their own, Blocks lazily creates a single shared VPC
  (generalizing the create-if-absent behavior `bb-data` already used for Aurora) and
  emits a notice about the NAT cost. Setting `defaults.vpc = { network }` remains the
  bring-your-own override.

  **`Database` accepts an optional `subnets` placement.** A CDK-free mirror of
  `ec2.SubnetSelection` (tier as a string, subnets by id) lets you steer where the
  Aurora cluster lands — for a bring-your-own VPC that lacks an isolated tier, or a
  compliance requirement to use specific subnets. Omit it to keep the default
  (prefer isolated, fall back to `private-with-egress`).

- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/core@0.5.0
  - @aws-blocks/bb-logger@0.2.0

## 0.2.0

### Minor Changes

- 1b66571: `FileBucket`: secure-by-default hardening. Several of these are **behavior/breaking changes** for existing consumers — because the package is pre-1.0 (0.x), this ships as a `minor` bump per the changesets convention that a `minor` signals a breaking change before 1.0.

  - **TLS enforced unconditionally.** Every provisioned bucket now sets `enforceSSL: true`, attaching a bucket policy that denies any request where `aws:SecureTransport` is `false`. Not configurable.
  - **Versioning defaults ON.** `versioned` now defaults to `true`; opt out with the literal `versioned: false`. **Breaking:** buckets that were previously non-versioned by default now enable versioning (prior versions accrue storage cost). The non-versioned option typings (no `versionId`) are selected only by the literal `versioned: false`; a non-literal `boolean` or an absent value resolves to the versioned-aware typings.
  - **Opt-in server access logging routed through stack posture.** New `accessLogging` option; when not set per-block it falls back to the stack `BlocksDefaults.accessLogging`. When enabled, a dedicated, locked-down log bucket (all public access blocked, S3-managed encryption, SSL enforced) receives the main bucket's access logs under the `access-logs/` prefix.
  - **Access-log retention follows the stack posture's `logRetention`.** Log expiration now derives from `BlocksDefaults.logRetention` (`ONE_WEEK` in sandbox / `ONE_YEAR` in production; `RetentionDays.INFINITE` keeps logs indefinitely) instead of a per-block day count. **Breaking (within this unmerged PR):** the per-block `logRetentionDays` option has been **removed** — access-log retention is no longer configured per-block.
  - **Removal policy routed through stack posture.** `removalPolicy` still accepts an explicit per-block `'destroy'|'retain'`; when omitted it now falls back to `BlocksDefaults.removalPolicy` (`DESTROY` in sandbox, `RETAIN` in production), replacing the previous `sandboxMode`-context behavior.
  - **New `noncurrentVersionExpirationDays` option** (default `90`). With versioning on (the default), noncurrent object versions are automatically expired after this many days to bound the storage cost that versioning would otherwise let grow unbounded. Must be a positive integer — a non-positive or non-integer value throws at synth. Disable versioning (`versioned: false`) to drop the rule entirely.
  - **Removed `Access-Control-Allow-Credentials: true`** from the local dev file-server's CORS response headers (it should never have been sent for anonymous, token-scoped presigned-URL access).
  - **Wildcard-CORS + mutating method now throws at synth.** A CORS rule combining a wildcard origin (`'*'`) with a mutating method (`PUT`/`POST`/`DELETE`) is rejected at synth with an actionable error. **Breaking:** such rules previously deployed unchallenged. Specify explicit origins for mutating methods; wildcard + `GET`/`HEAD` remains allowed.
  - **Mock mirrors the CDK synth-time validation.** The local/unit `FileBucket` now reproduces the CDK's two synth-time guards verbatim — the noncurrent-version-expiration range check (positive-integer, validated regardless of `versioned`) and the wildcard-CORS/mutating-method guard — so local and unit runs fail the same way `cdk synth` would (mock↔cdk parity). Both are gated on `!bucket`, matching the CDK's external-bucket early-return.
  - **External `bucket` option documented as not receiving the secure defaults.** The `bucket` option's TSDoc and the README "Wrapping an Existing Bucket" section now state that a wrapped/existing bucket bypasses every secure default (`enforceSSL`, versioning/noncurrent expiration, access logging, `blockPublicAccess`, encryption, the wildcard-CORS guard) — the caller owns that bucket's posture.

### Patch Changes

- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6

## 0.1.5

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role

  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.

  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.

- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-logger@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.1.3

### Patch Changes

- bd59e60: Harden the local dev file server against stored XSS and token forgery. Downloads are now served with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, so an uploaded `text/html`/SVG payload can no longer execute inline in the app's origin. The HMAC secret used to sign presigned-URL tokens is now a per-process random value instead of a hardcoded, source-visible literal, so tokens can no longer be forged offline. Both the token-minting mock and the validating dev file server share the same in-process value, so local presigned-URL round-trips are unaffected.
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-logger@0.1.3

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
