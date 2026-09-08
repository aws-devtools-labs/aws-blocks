# @aws-blocks/blocks

## 0.4.0

### Minor Changes

- 08ab129: Add `pointInTimeRecovery: boolean | { retentionDays: number }` to `BlocksDefaults` (and to `BlocksPresets`: `true` in `production`, `false` in `sandbox`).
  
  This extends the stack-wide infrastructure-defaults posture with the continuous-backup knob, so a Building Block whose service supports it (DynamoDB Point-in-Time Recovery) can resolve its default from `scope.defaults.pointInTimeRecovery` — read independently, the same way as `removalPolicy` and `deletionProtection`. `true` enables backups with the service default window, `false` disables them, and `{ retentionDays: n }` pins the window (the block validates `n` against its service's range) — on/off and window are one field since a window only means anything when backups are on. Blocks whose service has no equivalent simply ignore it. `bb-distributed-table` is the first consumer.
  
  > The property **name** (`pointInTimeRecovery`) and its `{ retentionDays }` shape are a public `@aws-blocks/core/cdk` surface addition and want API-BR sign-off before release.

### Patch Changes

- 1ff9d03: `AppSetting`: support a customer-managed KMS key for secrets via `kmsKeyArn`.
  
  Secret (`SecureString`) parameters were always encrypted with the default `aws/ssm` AWS-managed key, so their decrypt scope couldn't be controlled (e.g. for cross-account access or a dedicated key policy). Passing `kmsKeyArn` (also accepted by `AppSetting.fromExisting`) now encrypts the secret with that customer-managed key:
  
  - the bulk-init Custom Resource creates the parameter with the CMK (`KeyId`);
  - the shared handler is granted `kms:Decrypt`/`Encrypt` scoped to that specific key ARN (instead of the `aws/ssm` `ViaService` wildcard);
  - the runtime `put()` re-specifies the key on overwrite so it doesn't silently fall back to `aws/ssm`;
  - adding/changing/removing `kmsKeyArn` on an already-deployed secret re-encrypts its current value under the new key at deploy time, so decryption keeps working after a key rotation.
  
  `kmsKeyArn` is only valid with `secret: true` and must be a non-empty ARN. The default (no `kmsKeyArn`) is unchanged.
- 5798492: feat(bb-async-job): batch SQS messages by default, with a configurable batching window
  
  `AsyncJob` triggered its Lambda with `batchSize: 1`, so every queued job cost a
  full invocation. The default is now `batchSize: 10` with a new
  `maxBatchingWindowSeconds` option (0–300, default 5) that trades latency for
  fuller batches. SQS partial batch failure reporting is always enabled, so only
  the failed records of a batch are redelivered.
  
  Both options are now range-checked in the `AsyncJob` constructor, so an
  out-of-range value fails fast at synth time with `InvalidOptionException` naming
  the option instead of surfacing as an opaque CloudFormation error mid-deploy:
  `batchSize` must be 1–10 without a batching window (1–10000 with one), and
  `maxBatchingWindowSeconds` must be 0–300.
  
  Retry semantics are unchanged. SQS tracks `ApproximateReceiveCount` per message
  and partial batch responses redeliver only failed records, so `maxRetries` still
  means "attempts for this message" and the DLQ `maxReceiveCount` keeps its
  meaning at any batch size.
  
  This is a `patch` bump. Every package here is pre-1.0, where a `minor` bump is
  this repo's signal for a breaking change; this change is not breaking — the new
  default is a behavior change with an opt-out (`batchSize: 1` /
  `maxBatchingWindowSeconds: 0`), and both options are new and optional. The
  umbrella `@aws-blocks/blocks` gets the same bump because it re-exports
  `AsyncJob` and `AsyncJobOptions`.
  
  `@aws-blocks/core/cdk` now exports `SHARED_HANDLER_TIMEOUT_SECONDS`, the shared
  handler Lambda's timeout, so resources that must size their own timeouts against
  it stop re-hardcoding `900`.
  
  The main queue's visibility timeout is now `SHARED_HANDLER_TIMEOUT_SECONDS + maxBatchingWindowSeconds`
  seconds instead of a flat `900`. A message becomes invisible when the poller
  receives it, before the batching window elapses and before the handler runs, so
  a flat 900s let SQS redeliver a message whose invocation was still running.
  
  `bb-agent` opts out of the new defaults with `batchSize: 1` and
  `maxBatchingWindowSeconds: 0`. It submits an internal job per interactive agent
  turn (plus a second on HITL resume) and the caller is blocked on that job
  starting, so a batching window would add up to 5s of latency to a human-facing
  path; `batchSize: 1` also keeps one failing turn from sharing a batch with
  others, which matters because the handler is not idempotent. Both the runtime
  and CDK construction sites set the same options so they synthesize an identical
  event source mapping.
- ca8cfb6: feat(bb-async-job): submitBatch auto-chunks batches larger than SQS limits
  
  `submitBatch` previously rejected any batch over 10 payloads with
  `BatchTooLarge`, so a caller with more than 10 jobs had to reimplement SQS's
  chunking rules by hand. It now accepts up to 10,000 payloads and packs them
  into `SendMessageBatch` requests bounded by both SQS per-request limits — at
  most 10 entries and at most 256 KB of aggregate message body — sent with
  bounded concurrency (at most 5 requests in flight) rather than one long serial
  loop. Each batch entry's `Id` is the payload's original index, so the returned
  `jobIds` stay in input order and every id is the same SQS `MessageId` that
  `getStatus()` / `waitUntilComplete()` look up. `BatchTooLarge` is now thrown
  only when a batch exceeds the 10,000-payload soft cap — a guardrail against a
  single call fanning out to an unbounded number of SQS requests.
  
  A batch spanning multiple chunks is **not atomic**: an earlier chunk can land
  before a later one fails. The all-or-nothing signal is unchanged — a partial
  failure still throws `BatchSubmitFailed` — but the thrown error (now a typed
  `BatchSubmitFailedError`) reflects the partial reality across all chunks:
  `.jobIds` carries the real `MessageId` for every entry that made it onto the
  queue (with `null` at each failed index) and `.failed[]` lists every failure
  sorted by index, so a caller can retry only the failed indexes instead of
  re-submitting the whole batch. Two failure kinds feed `.failed[]`: an
  entry-level rejection is scoped to its index, while a transport-level `send()`
  rejection (throttling, connection, auth) fails that whole chunk and
  short-circuits the chunks not yet started (`code: 'BatchSubmitAborted'`) instead
  of hammering an unhealthy endpoint. An entry SQS returns in neither list becomes
  a `MissingResult` failure so a `null` id never escapes as a success.
  
  On full success the `trackStatus` write is now best-effort — a failure recording
  `queued` (e.g. DynamoDB throttling on a large fan-out) is logged rather than
  thrown, since the handler backfills the record anyway; otherwise a bookkeeping
  error would make a caller re-submit an already-enqueued batch. `recordQueuedBatch`
  also issues its conditional writes in groups of 25 (mirroring `BatchWriteItem`)
  rather than one unbounded `Promise.all`.
  
  The mock runtime submits one message at a time and never partially fails, so the
  transport/abort paths are AWS-only; it enforces the same soft cap and validates
  every payload before enqueuing any, matching the AWS runtime.
  
  This is a `patch` bump: pre-1.0, this repo uses `minor` to signal a breaking
  change, and this is not breaking — a batch of ≤10 behaves exactly as before, no
  public type changed (`BatchSubmitFailedError` is additive), and the previous
  `BatchTooLarge` threshold simply moved from 10 to 10,000. `@aws-blocks/blocks`
  gets the same bump because it re-exports `AsyncJob`.
- f00adb0: feat(core): resolve `Scope.compute`; the default compute owns the handler + gateway
  
  Add a `Scope.compute` getter that resolves the compute a block runs on: the
  nearest `_compute` assigned on the block or an ancestor scope, else the owning
  stack/backend's default compute.
  
  The default is a `LambdaCompute` that now **owns** the Lambda function + API
  Gateway. `setupBlocksInfra` no longer creates them; `BlocksStack` /
  `BlocksBackend` expose `handler` / `gateway` / `apiUrl` as getters that delegate
  to the default compute. The compute is created in `create()` before the backend
  module is imported, so a block reading `this.compute` in its constructor
  resolves to it. `_compute` is internal (no public option yet).
  
  Core no longer imports a concrete compute: `create()` requires a
  `defaultComputeFactory` on its props (`CoreBlocksStackProps` /
  `CoreBlocksBackendProps` — the public `BlocksStackProps` / `BlocksBackendProps`
  plus that factory) and calls it to build the default. The umbrella
  `@aws-blocks/blocks` supplies `LambdaCompute` by spreading the factory onto the
  props in a thin `create()` wrapper, so apps built on `@aws-blocks/blocks` are
  unaffected — their call site is unchanged.
  
  **Breaking (direct `@aws-blocks/core` consumers only):** core no longer provides
  a built-in default compute. `BlocksStack.create()` / `BlocksBackend.create()`
  now require a `defaultComputeFactory` field on the props (typed
  `CoreBlocksStackProps` / `CoreBlocksBackendProps`); props without it no longer
  type-check (and it throws at synth if forced). This break is inherent to moving
  the Lambda + API Gateway out of core — it is not specific to how the factory is
  passed. Migrate by either:
  
  - using `@aws-blocks/blocks` (`import { BlocksStack } from '@aws-blocks/blocks/cdk'`),
    which injects a Lambda default for you — the recommended path; or
  - supplying your own factory on the props:
    `BlocksStack.create(scope, id, { ...props, defaultComputeFactory: (root) => new LambdaCompute(root, 'DefaultCompute') })`,
    which requires depending on `@aws-blocks/bb-lambda-compute` and the internal
    `@aws-blocks/core/cdk/internal` types.
  
  **Resource replacement on redeploy:** because the Lambda function and API
  Gateway now live under the default compute's construct path
  (`.../DefaultCompute/...`), their CloudFormation logical IDs change, so a
  redeploy **replaces** the function + API Gateway and the API URL changes. These
  are internal resources, not a customer-facing contract. Any consumer with an
  already-deployed stack — in particular an Amplify Gen2 frontend wired to the
  current API Gateway URL (this repo carries a Gen2 nested-stack regression test,
  so Gen2 integration is real) — should confirm they can absorb a URL change
  before upgrading.
- de4f209: `KnowledgeBase.retrieve`: validate `maxResults` consistently across the mock and AWS runtimes.
  
  `maxResults` was normalized with `Math.min(Math.max(v ?? 10, 1), 100)`, which silently passed fractional and non-finite values (`1.5`, `NaN`, `Infinity`) straight through — the mock and the AWS `RetrieveCommand` then diverged, and Bedrock rejects a non-integer `numberOfResults`. A new shared `normalizeMaxResults` helper (used by both runtimes) keeps the documented clamp for finite integers and now rejects fractional/non-finite values up front with `KnowledgeBaseErrors.ValidationError`, before any search or Bedrock request.
  
  Fixes #430.
- f00adb0: `LambdaCompute`: default the function to **arm64 (AWS Graviton)**.
  
  The compute's Lambda now defaults to `Architecture.ARM_64` instead of CDK's `x86_64` default. arm64 Lambda is ~20% cheaper per GB-second than x86_64 at equivalent performance. Because `LambdaCompute` is the default compute for every `@aws-blocks/blocks` app, the shared handler runs on Graviton out of the box.
  
  The framework's own Building Blocks are pure-JavaScript esbuild bundles with no architecture-specific native code, so the switch is transparent for them. A backend `entry` bundle is the customer's own handler plus whatever they import, though — so an app that bundles an **x86-only native dependency** into its backend should be aware of the default. There is no per-app override yet; a customer-facing way to pin the architecture (`architecture` on `LambdaComputeProps` is present but internal for now) will be exposed alongside the public compute-configuration surface.
  
  > **Behavior change on next deploy:** the handler function's architecture is `arm64` (an in-place update on an existing function).
- 27346f3: Make AuthOIDC `requireAuth()` throw `ApiError(401, NotAuthenticatedException)` so the documented `handle401()` 401-redirect pattern works for a signed-out protected call.
  
  Previously `requireAuth()` threw a bare `Error` with no `status`. Over the JSON-RPC boundary `errorResponseFromCatch` serializes a non-`ApiError` as code `500`, so the client received an `ApiError` with `status === 500`. The README's `if (handle401(e, provider)) return;` helper only acts on `err instanceof ApiError && err.status === 401`, so it never matched and the app never redirected to sign-in — the error just surfaced. This aligns AuthOIDC with AuthCognito, whose `requireAuth()` already throws `ApiError(401, …)`. The error name is preserved, so existing `isBlocksError(e, AuthOIDCErrors.NotAuthenticated)` checks are unaffected.
- 5bfae0a: Reject oversized JSON-RPC request bodies at the shared parser. `parseRpcRequest` now caps the body at 10 MiB (`MAX_RPC_BODY_BYTES`, the same limit API Gateway enforces in production) and returns a `413` error named `PayloadTooLarge` before parsing or dispatch. In production API Gateway rejects an oversized body at the edge before the Lambda runs; enforcing the same limit at the parser means the local dev server rejects the same body instead of buffering it and wedging the local database (e.g. PGlite). Because both the Lambda handler and the dev server route through this one parser, the cap lives in a single place, and `decodeRpcResponse` surfaces it client-side as `ApiError.status === 413`.
- 0ac3879: `sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.
  
  Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run a bounded STS `GetCallerIdentity` check up front and, on a real credential error (missing/expired/invalid), exit immediately with guidance (`aws configure` / `aws sso login`, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.
  
  The check is deliberately conservative: it only blocks on a genuine credential error (surfacing the SDK error *name*, never the raw message, which can embed an ARN/account id); a network or service error warns and lets the deploy proceed; and it skips (with a warning) when no region is set in `AWS_REGION` / `AWS_DEFAULT_REGION`, rather than guessing a region in the wrong partition (GovCloud/China). The scaffolded `sandbox` template entrypoint now `.catch`es and exits cleanly, matching `deploy`, so the guidance prints without an unhandled-rejection stack trace.
- Updated dependencies [1ff9d03]
- Updated dependencies [5798492]
- Updated dependencies [ca8cfb6]
- Updated dependencies [08ab129]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [de4f209]
- Updated dependencies [f00adb0]
- Updated dependencies [27346f3]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
- Updated dependencies [9bd5b3e]
  - @aws-blocks/bb-app-setting@0.2.0
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-async-job@0.1.5
  - @aws-blocks/bb-agent@0.3.5
  - @aws-blocks/bb-distributed-table@0.1.6
  - @aws-blocks/bb-lambda-compute@0.3.0
  - @aws-blocks/bb-kv-store@0.1.7
  - @aws-blocks/bb-file-bucket@0.1.5
  - @aws-blocks/bb-data@0.2.6
  - @aws-blocks/bb-knowledge-base@0.2.2
  - @aws-blocks/bb-email-client@0.1.5
  - @aws-blocks/bb-auth-cognito@0.1.8
  - @aws-blocks/bb-auth-oidc@0.1.9
  - @aws-blocks/bb-distributed-data@0.1.7
  - @aws-blocks/hosting@0.2.0
  - @aws-blocks/bb-auth-basic@0.1.7
  - @aws-blocks/bb-realtime@0.1.5
  - @aws-blocks/auth-common@0.1.6
  - @aws-blocks/bb-cron-job@0.1.5
  - @aws-blocks/bb-dashboard@0.1.4
  - @aws-blocks/bb-logger@0.1.5
  - @aws-blocks/bb-metrics@0.1.5
  - @aws-blocks/bb-tracer@0.1.7

## 0.3.1

### Patch Changes

- 448a47c: fix(bb-lambda-compute): add package metadata, prebuild, and pin dependency ranges
  
  Bring `@aws-blocks/bb-lambda-compute`'s package.json in line with its siblings:
  
  - add the `repository` / `homepage` / `bugs` blocks. Without `repository.url`,
    provenance publishing fails with `E422 … "repository.url" is ""` because npm
    cannot match the package against the sigstore attestation's source repo;
  - add the `prebuild` version-generation script (`generate-version.mjs`);
  - pin `@aws-blocks/core` to `^0.2.0` instead of `*`, matching every other
    package.
  
  Also pin the umbrella `@aws-blocks/blocks`'s dependency on
  `@aws-blocks/bb-lambda-compute` to `^0.2.0` instead of `*`, now that the package
  publishes a real version.
- Updated dependencies [448a47c]
  - @aws-blocks/bb-lambda-compute@0.2.1

## 0.3.0

### Minor Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.
  
  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).
  
  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)
  
  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.
  
  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.

### Patch Changes

- 6df9e2d: fix(data): declare the `data-common` TypeScript project reference in `bb-data` and `bb-distributed-data`
  
  Both packages depend on `@aws-blocks/data-common` in `package.json`, but neither
  listed it in its `tsconfig.json` `references`. Because `src/` ships in these
  tarballs, `data-common`'s declarations have to already exist for the compiler to
  resolve `@aws-blocks/data-common` — and nothing in the project-reference graph
  guaranteed that.
  
  Correct build order was therefore supplied by the position of `data-common` in
  the root `workspaces` array (index 8, ahead of `bb-data` at 10 and
  `bb-distributed-data` at 11) rather than by the dependency graph. Any build that
  does not follow that array order fails with:
  
  ```
  packages/bb-distributed-data/src/validation.ts(12,54): error TS2307:
    Cannot find module '@aws-blocks/data-common' or its corresponding type declarations.
  ```
  
  That was already reachable from the repo's own scripts: the former
  `npm run build:packages` resolved its `-w` targets in a different order and hit
  exactly this, which is why `scripts/agent-bench/steps/1-init-bench-app.sh`
  carried the comment "`build:packages` runs alphabetically and trips over
  bb-data". Adding the two missing references fixes the root cause, so build order
  now comes from the project-reference graph rather than from the ordering of the
  root `workspaces` array.
  
  No API, runtime, or packaged-output change — `tsconfig.json` is not in either
  package's `files`, so the published tarballs are unchanged.
- 3614a09: Stop `import.meta.url` from crashing the deployed Lambda. The backend handler is bundled to CommonJS, where `import.meta` is empty, so `fileURLToPath(import.meta.url)` in a handler, a Building Block's `aws-runtime` code, or a dependency became `fileURLToPath(undefined)` and threw at Lambda load (every request 502'd). esbuild only warned, so the broken bundle deployed. The handler bundling now shims `import.meta.url` / `import.meta.dirname` / `import.meta.filename` to their CommonJS equivalents (`pathToFileURL(__filename)`, `__dirname`, `__filename`) — the approach esbuild blesses and Rollup applies by default — so the bundle loads cleanly and a dependency that merely contains `import.meta` no longer trips a build failure. Exposes `blocksNodejsBundling()` from `@aws-blocks/core/cdk` (re-exported by `@aws-blocks/blocks`) so every framework `NodejsFunction` gets the same treatment. Note: inside the bundle these resolve to the bundled output location, not your source tree.
- edbf1aa: fix(bb-knowledge-base): disable `installLatestAwsSdk` on the ingestion custom resource
  
  The `StartIngestion` `AwsCustomResource` left `installLatestAwsSdk` at its default
  (`true`), so the provider Lambda ran an `npm install` of the AWS SDK on every
  invocation before it could call the API. That costs roughly 15-30s of extra cold
  start and raises the shared provider Lambda to 512MB of memory, though that
  reduction is only realized once every `AwsCustomResource` in the stack opts out —
  the provider is a stack-level singleton and its `memorySize` is resolved once at
  synth. The per-resource cold-start saving applies regardless.
  
  Nothing needed it. The resource calls `BedrockAgent.startIngestionJob`, a stable
  API already bundled in the Lambda runtime's AWS SDK v3, so the bundled client is
  sufficient and the install is pure overhead. Setting `installLatestAwsSdk: false`
  also silences CDK's `installLatestAwsSdkNotSpecified` synth-time warning for this
  construct.
  
  The tradeoff being accepted: the provider now uses whichever SDK v3 the Lambda
  runtime bundles at deploy time rather than installing the newest one. That is safe
  here because `startIngestionJob` is a foundational Bedrock Agent operation present
  since the client's initial release, not a recent addition.
  
  Internal construct wiring only — no public API change. The synthesized
  `Custom::AWS` resource now renders `InstallLatestAwsSdk: false`.
  
  Upgrade note: because `InstallLatestAwsSdk` renders as a property on the
  `Custom::AWS` resource while the `physicalResourceId` stays stable, the first
  deploy after upgrading is a CloudFormation *Update* and fires `onUpdate` — so one
  `startIngestionJob` kicks off. This is harmless (ingestion is idempotent and
  fire-and-forget), but expect to see an ingestion start right after upgrading.
- 5262062: feat: extract `LambdaCompute` into `@aws-blocks/bb-lambda-compute`
  
  The abstract `Compute` base stays in core as a framework primitive; the concrete
  `LambdaCompute` (a `NodejsFunction` fronted by its own API Gateway, assuming the
  shared execution role) moves into a new package, `@aws-blocks/bb-lambda-compute`.
  
  The package is CDK-only and its sole export is internal — customers cannot
  instantiate a compute yet. Nothing in the default path constructs it, so this is
  additive and non-breaking.
- bfb9a63: Polish the PGlite init-retry helper (`data-common`) following #205 review:
  
  - Narrow the WASM-trap classifier to specific signatures (`RuntimeError: unreachable`, `wasm trap: unreachable`, Emscripten `Aborted(<reason>)`) instead of matching the bare word `unreachable`, so an unrelated probe failure whose text/stack merely contains "unreachable" (e.g. an `assertUnreachable` helper) is no longer misclassified as retryable. The `Aborted(` prefix (not just the empty `Aborted()`) is matched so memory-pressure aborts like `Aborted(Cannot enlarge memory arrays)` / `Aborted(OOM)` — the case this retry exists for — are caught. A `RuntimeError`-named error whose message contains `unreachable` is also treated as a trap, so the real V8/Node trap (message is literally `"unreachable"`, prefix only in the stack) is caught without depending on the stack surviving.
  - Classify retryability BEFORE consulting the attempt budget in `initializePgliteWithRetry`, so instance cleanup is uniform (a non-retryable error is always rethrown untouched) and `maxAttempts === 1` no longer closes the instance on a non-trap failure.
  - Guard `maxAttempts` against `NaN` (which `?? 3` does not default), preventing an unbounded close/recreate loop on a persistent trap.
  - Wrap a `recreate()` failure so the original init trap is preserved as the error `cause`, keeping debugging pointed at "PGlite kept trapping" rather than only the secondary recreate error.
  - Mark the four init-retry exports (`initializePgliteWithRetry`, `isPgliteUnreachableTrap`, `PgliteLike`, `PgliteInitRetryOptions`) `@internal` — they exist only so the engine packages can share the helper — and document the `PgliteLike` methods.
- e4b1498: Retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap.
  
  PGlite defers `initdb` to the first query, which can trap with `unreachable` under memory pressure (notably on CI when several PGlite-backed dev servers boot concurrently) and kill the dev server mid-`runMigrations`. `PGliteEngine` (bb-data) and `DsqlMockEngine` (bb-distributed-data) now force initialization through a shared bounded retry (`initializePgliteWithRetry` in data-common) that closes the aborted WASM instance and boots a fresh one, so a transient init trap recovers instead of crashing the process.
- 8966cfb: fix(telemetry): detect Render and Taskcluster as CI
  
  Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
  omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
  service; Taskcluster tasks always set the namespaced `TASKCLUSTER_ROOT_URL`.
  Runs on those platforms were therefore reported as real user sessions instead
  of `ci:true`, inflating user metrics. `RENDER` and `TASKCLUSTER_ROOT_URL` are
  now included in both `isCI()` implementations (`@aws-blocks/core` and
  `@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
  bump because it re-exports `@aws-blocks/core`.
- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [6df9e2d]
- Updated dependencies [3614a09]
- Updated dependencies [edbf1aa]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [e4b1498]
- Updated dependencies [406ba89]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-kv-store@0.1.6
  - @aws-blocks/bb-data@0.2.5
  - @aws-blocks/bb-distributed-data@0.1.6
  - @aws-blocks/bb-distributed-table@0.1.5
  - @aws-blocks/bb-knowledge-base@0.2.1
  - @aws-blocks/bb-lambda-compute@0.2.0
  - @aws-blocks/bb-realtime@0.1.4
  - @aws-blocks/auth-common@0.1.5
  - @aws-blocks/bb-agent@0.3.4
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-async-job@0.1.4
  - @aws-blocks/bb-auth-basic@0.1.6
  - @aws-blocks/bb-auth-cognito@0.1.7
  - @aws-blocks/bb-auth-oidc@0.1.8
  - @aws-blocks/bb-cron-job@0.1.4
  - @aws-blocks/bb-dashboard@0.1.3
  - @aws-blocks/bb-email-client@0.1.4
  - @aws-blocks/bb-file-bucket@0.1.4
  - @aws-blocks/bb-logger@0.1.4
  - @aws-blocks/bb-metrics@0.1.4
  - @aws-blocks/bb-tracer@0.1.6

## 0.2.7

### Patch Changes

- 1e37c67: docs: per-block docs folders + committed BB catalog with CI sync check; CLAUDE/agents docs resolved via require.resolve

  `@aws-blocks/blocks` now ships one docs folder per Building Block under `docs/<block>/`
  (`README.md` / `API.md` / `DESIGN.md`), plus a committed, marker-delimited Building Block
  catalog in the package README that a `sync-docs --check` CI gate keeps in sync. The README's
  catalog section and the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`) now direct
  tools and agents to locate docs programmatically via
  `require.resolve('@aws-blocks/blocks/docs/<block>/README.md')` (and
  `require.resolve('@aws-blocks/blocks/docs/README.md')` for the catalog) rather than assuming a
  `node_modules/` path or following the human-facing relative links. Also adds a Security
  Considerations section to the package README.

- Updated dependencies [cb779c8]
  - @aws-blocks/core@0.1.18

## 0.2.6

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 2ed4177: Add stable `data-testid` hooks to the auth UI components so e2e suites can target the shipped `Authenticator` instead of forking it. Covers every interactive element (field inputs, hidden ones included, and submit buttons) plus the containers worth asserting against: the root, per-action wrappers, heading, error, the signed-in marker, `AuthenticatedContent`, and `AccountMenuBar`. Presentational markup such as hint text and layout wrappers stays unhooked. The full selector contract, including the `<action>:<provider>` form federated actions produce, is documented in CUSTOMIZING-AUTH-UI.md.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because it re-exports these components from `@aws-blocks/auth-common/ui`. Sibling patch releases stay inside the umbrella's caret ranges, so `changeset version` never bumps it on its own (#212), and it is republished explicitly to stay in step with the components it hands to consumers.

- 5b2aede: `DistributedTable`: reconcile reads with the schema via a new `readValidation` mode (default `'coerce'`).

  **Behavioral change to the read path (preview).** Writes always validated against `schema`, but reads (`get`, `getBatch`, `query`, `scan`) returned the raw stored value. After a schema change, a row written under the old schema no longer conformed to type `T`: a newly added field was absent from the read (so the value silently violated `T`, and a `.default()` was never applied or persisted on write-back), and a required-no-default field made the read-modify-write cycle (`get()` → mutate → `put()`) throw `ValidationFailed`.

  Reads now reconcile stored items with the schema via `readValidation?: 'off' | 'coerce' | 'strict'`:

  - **`'coerce'`** (default) — apply the schema (fill defaults, narrow types) so legacy rows conform to `T` and round-trip cleanly, **without dropping data**: the coerced output is deep-merged over the raw stored item, so attributes not in the current schema (older-schema fields, columns another writer owns) are preserved rather than silently stripped on a read-modify-write. Arrays are replaced wholesale. On a value that can't be coerced, return the raw value + log a warning — **never throws**.
  - **`'strict'`** — throw `ValidationFailed` on any non-conforming item (opt-in; treats a mismatch as corruption).
  - **`'off'`** — return the raw stored value with no validation (the previous default behavior).

  ```ts
  const orders = new DistributedTable(scope, "orders", {
    schema: orderSchemaV2, // adds `currency: z.string().default('USD')`
    key: { partitionKey: "orderId" },
    // readValidation: 'coerce' is the default
  });
  const order = await orders.get({ orderId: "o1" }); // legacy row → currency: 'USD'
  await orders.put({ ...order, total: 20 }); // conforms to T; round-trips
  ```

  Migration note: the default is now `'coerce'` (previously reads returned raw values). Pass `readValidation: 'off'` to restore raw reads. Coercion is best-effort and validator-dependent — transform-bearing schemas (e.g. Zod) fill defaults and narrow types; check-only Standard Schema validators pass values through unchanged. `null` (a missing item) is untouched in all modes.

- feb5be4: Re-export the `auth.admin` types (`AdminOptions`, `AdminUser`, `AdminCreateInit`, `GroupAdmin`, `LifecycleAdmin`, `AdminSurface`, `AdminGetterOf`, `AdminDisabled`) from the umbrella package so consumers using `@aws-blocks/blocks` can name the values `auth.admin` returns and annotate `admin` options.
- 9de27dd: fix(core): stream CloudFormation progress to stdout and stop a stray SIGTERM from killing an in-flight deploy

  `npm run deploy` wrote nothing to stdout for the whole CloudFormation phase, and
  a backgrounded deploy was killed (exit 143) while CloudFormation kept going and
  finished server-side. Callers had no progress signal, could not tell success from
  failure, and re-ran deploys that had actually worked.

  Two causes, both fixed:

  - The CDK CLI picks its log stream as `isCI ? stdout : stderr`, so every
    CloudFormation event went to stderr and `npm run deploy > deploy.log` captured
    zero bytes. The deploy now passes `--ci` (log lines on stdout, errors still on
    stderr) and `--progress events` (one line per resource transition instead of a
    progress bar that needs a TTY).
  - The deploy ran `cdk deploy` through a blocking synchronous spawn with the child
    in this process's group, so signals could not be handled and the default
    SIGTERM disposition killed the CLI mid-deploy. The CDK CLI is now spawned in
    its own process group with its output piped and relayed line by line as it
    arrives, plus an idle heartbeat while a slow resource is converging. A single
    SIGTERM, or any SIGHUP, no longer abandons a converging deploy: it logs and
    keeps streaming. Ctrl-C, or a second SIGTERM, aborts and reaps the CDK process
    tree. Repeat deliveries of the same signal inside the coalescing window log one
    line instead of one per delivery.

  Worth knowing before you upgrade:

  - **The signal resilience is POSIX-only.** It needs process groups (`detached` is
    passed only when `process.platform !== 'win32'`) and real signal delivery, and
    Windows has neither: nothing outside the process delivers SIGTERM/SIGHUP there,
    so a kill on the process tree still ends the deploy and the abort path reaps by
    pid. Streaming, the heartbeat and the `--ci` argv apply on every platform.
  - **The `❌ Deployment failed.` banner moved from stderr to stdout**
    (`console.error` → `console.log`), so a caller capturing only stdout can tell a
    failed deploy from a killed process. Anything grepping _stderr_ for that exact
    string will no longer match it. The failure _reason_ has not moved: the CDK CLI
    keeps error-level output on stderr even under `--ci`, and the deploy entrypoint
    still prints the error itself with `console.error`, so stderr remains the place
    to grep for why a deploy failed. Both halves of that split are now covered by
    tests, including one against the real CDK CLI.

- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- b83aaba: Add opt-in TTL support to `KVStore` and use it to expire `AuthCognito` session records.

  `KVStore` gains a `ttl` construct option that enables DynamoDB Time-to-Live on the table, plus per-write expiry via `put(key, value, { ttlSeconds })` or `{ expiresAt }`. Both default to off, so existing tables and every existing `put()` call are unaffected. Because DynamoDB deletes expired items asynchronously, `get` and `scan` also filter expired items on read in every runtime, and the local mock emulates the same expiry semantics. Maintenance sweeps that need to act on rows the reaper has not collected yet can opt out with `scan({ includeExpired: true })`.

  `AuthCognito` now enables TTL on its sessions table and stamps each session write with `now + sessionTtlSeconds`. Session records store live Cognito refresh tokens, so without an expiry the table grew without bound and retained those credentials at rest indefinitely; abandoned sessions are now reaped automatically. Authorization is unchanged — validity is still decided by token revalidation on every request.

  Two things to know before upgrading:

  - **Your next `cdk deploy` enables TTL on the existing sessions table.** Even though this is a patch, `AuthCognito` now passes `{ ttl: true }`, so the deploy issues a one-time `UpdateTimeToLive` against the live table. That is an online, non-disruptive DynamoDB operation — no downtime, no data loss — but it is a mutation of a live resource, so it shouldn't surprise anyone diffing a patch upgrade.
  - **Only sessions written after the upgrade expire.** A missing `ttl` attribute means "never expires" (matching DynamoDB), and existing rows are not backfilled, so sessions created before the upgrade keep their refresh tokens at rest indefinitely. Backfilling would need a one-time migration writing `ttl` onto every existing row. To close the retention gap immediately, revoke the pre-existing sessions instead — the revoke sweep deletes rows regardless of expiry state.

- f583c75: Add opt-in job status tracking to AsyncJob

  Pass `trackStatus: true` and AsyncJob records each job's lifecycle, which you can read with two new methods:

  - `getStatus(jobId)` returns the job's current state plus every state it has passed through.
  - `waitUntilComplete(jobId, options?)` waits until the job reaches `complete` or `failed`, with `timeoutMs`, `pollIntervalMs`, and `AbortSignal` support.

  Transitions are appended rather than overwritten, so intermediate states stay observable no matter when you read them. A handler that finishes in a millisecond still records that it went through `processing`, and a caller that checks once after the job settled sees the whole sequence. That removes the need to pad a handler with an artificial delay just to make the `processing` state catchable, and a retry appends another `processing` entry so attempt counts are visible too.

  Appends are guarded by a compare-and-swap, so the two ways two writers can hold the same record at once cannot drop a transition: a `queued` write arriving after SQS already delivered the message, and a duplicate delivery of the same message on an at-least-once queue.

  When the handler gets there first it creates the record itself, dating the submission from the moment it first saw the job, since that is all it knows. The `queued` write that arrives afterwards replaces that placeholder with the real submission time instead of dropping it, so `submittedAt` and the first transition always report when the job was submitted rather than when it started being processed.

  Enabling the flag provisions one DynamoDB table for the job's status records, with a 24 hour TTL, and adds a write on submit plus one per state change. Leave it off and nothing is provisioned; `submit()` stays a single SQS call and the status methods throw `StatusNotTracked`.

  Status writes on the handler path are logged rather than thrown, so bookkeeping can never retry work that succeeded or mask work that failed. The trade is that a dropped terminal write leaves a finished job without a terminal state, so read `waitUntilComplete()`'s `Timeout` as "status unknown" rather than "still running".

- 3c56267: `AuthBasic` and `Logger` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  Both were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but neither passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name either block, so `product.buildingBlocks` under-reported two of the most widely used blocks. Each package now carries the standard `prebuild` (`generate-version.mjs AuthBasic` / `Logger`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `Logger` is composed internally by most other blocks (`new Logger(this, 'logger', { level: 'error' })`), so it will now be reported for effectively every application, and `totalCount` rises accordingly. That is the intended reading of the existing `Logger` entry in the vendorize map, not a new disclosure: `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

  `@aws-blocks/blocks` takes a `patch` because it re-exports both blocks; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own (#273, #212). `@aws-blocks/core` needs no bump — both names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- 0491157: `Metrics`, `Tracer`, and `DistributedDatabase` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  All three were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but none passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name them, so `product.buildingBlocks` under-reported them. Each package now carries the standard `prebuild` (`generate-version.mjs Metrics` / `Tracer` / `DistributedDatabase`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `bb-tracer` and `bb-distributed-data` ship distinct mock implementations (their default entry does not re-export the AWS class), so both `index.aws.ts` and `index.mock.ts` carry the change; `bb-metrics`'s mock re-exports the AWS class, so its single runtime change covers both conditions. CDK entry points are deliberately left alone — telemetry is reported by the runtime class, not the synth-time construct.

  This is a follow-up to #298 (`AuthBasic`/`Logger`), completing telemetry parity for every vendorized block whose runtime class extends `Scope`. `@aws-blocks/blocks` takes a `patch` because it re-exports all three; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own. `@aws-blocks/core` needs no bump — all three names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- Updated dependencies [75f5446]
- Updated dependencies [feb5be4]
- Updated dependencies [2ed4177]
- Updated dependencies [feb5be4]
- Updated dependencies [49b3bd9]
- Updated dependencies [5b2aede]
- Updated dependencies [7b3bb06]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [bd59e60]
- Updated dependencies [b83aaba]
- Updated dependencies [a584007]
- Updated dependencies [f583c75]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
- Updated dependencies [0491157]
  - @aws-blocks/auth-common@0.1.4
  - @aws-blocks/bb-auth-cognito@0.1.6
  - @aws-blocks/bb-agent@0.3.3
  - @aws-blocks/bb-data@0.2.4
  - @aws-blocks/bb-distributed-table@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-auth-oidc@0.1.7
  - @aws-blocks/bb-file-bucket@0.1.3
  - @aws-blocks/bb-kv-store@0.1.5
  - @aws-blocks/bb-distributed-data@0.1.5
  - @aws-blocks/bb-async-job@0.1.3
  - @aws-blocks/bb-auth-basic@0.1.5
  - @aws-blocks/bb-logger@0.1.3
  - @aws-blocks/bb-metrics@0.1.3
  - @aws-blocks/bb-tracer@0.1.5

## 0.2.5

### Patch Changes

- 0f3c73c: Reject `ALTER TABLE DROP COLUMN` at dev time, including the keyword-less Postgres shorthand (`ALTER TABLE t DROP col` / `DROP IF EXISTS col`). It is not in DSQL's supported `ALTER TABLE` subset ("unsupported ALTER TABLE DROP COLUMN statement", 0A000), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. The supported forms — `ALTER COLUMN ... DROP DEFAULT` / `DROP NOT NULL` / `DROP EXPRESSION` / `DROP IDENTITY` and `DROP CONSTRAINT` — are not affected.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-distributed-data` README update changes `@aws-blocks/blocks` packaged content.

- Updated dependencies [0f3c73c]
  - @aws-blocks/bb-distributed-data@0.1.4

## 0.2.4

### Patch Changes

- 09b94b8: Bump the Database block's Aurora PostgreSQL engine version from the retired `16.4` to `16.13`, and make the engine version configurable.

  AWS retired Aurora PostgreSQL `16.4` in us-east-1, after which `CreateDBCluster` failed with `Cannot find version 16.4 for aurora-postgresql`, blocking every deployment of a `Database` block. The default now points at the latest available `16.x` minor (`16.13`) for the longest deprecation runway.

  A new optional `postgresVersion` option on `DatabaseOptions` lets callers override the engine version (e.g. `postgresVersion: '16.13'`), so the next AWS retirement is a configuration change rather than a framework code fix. Overrides are validated at synth time (must be `MAJOR.MINOR`, e.g. `16.13`), so a malformed value fails fast with a clear error instead of an opaque `CreateDBCluster` failure.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-data` README update changes `@aws-blocks/blocks` packaged content.

- Updated dependencies [09b94b8]
  - @aws-blocks/bb-data@0.2.3

## 0.2.3

### Patch Changes

- fc8cfad: Republish the umbrella `@aws-blocks/blocks` package so its tarball matches the updated re-exported APIs (`@aws-blocks/core`, `@aws-blocks/bb-agent`) and synced block docs. The sibling patch releases stayed within `blocks`' caret dependency ranges, so `changeset version` did not auto-bump the umbrella package, and the publish integrity guard requires a version bump when packed content changes.
- Updated dependencies [c4313cd]
- Updated dependencies [997c736]
  - @aws-blocks/bb-agent@0.3.2

## 0.2.2

### Patch Changes

- d898838: Include synced building block documentation updates.

## 0.2.1

### Patch Changes

- 8de7091: Include synced building block documentation updates.
- Updated dependencies [c7f1e7c]
- Updated dependencies [5491cae]
  - @aws-blocks/bb-distributed-data@0.1.3
  - @aws-blocks/bb-realtime@0.1.3

## 0.2.0

### Minor Changes

- b6fb281: Add `isSynced()` / `waitUntilSynced()` ingestion-sync API to KnowledgeBase.

  Bedrock ingestion runs asynchronously after deploy, so during the initial pre-sync window `retrieve()` returns an empty array even for queries that would later match — making "empty" ambiguous between "not yet synced with your latest data" and "synced, no match". The new methods resolve that ambiguity (mirroring Bedrock's own "Sync" / "sync with your latest data" terminology):

  - `isSynced(): Promise<boolean>` — `true` once the data source's most recent ingestion job is `COMPLETE`; `false` while it is not yet synced with your latest data. This reports data _freshness_, not availability — `retrieve()` is always callable and serves the prior synced snapshot during a re-ingestion. Both local-folder and imported `s3://` sources register a BB-managed data source, so both are tracked (the "no managed data source → synced" shortcut applies only to deployments predating this API, which have no data source id injected). Throws a typed `IngestionFailedException` (including `failureReasons`) if the latest job failed.
  - `waitUntilSynced(options?: { timeoutMs?: number; pollIntervalMs?: number; maxConsecutiveTransientErrors?: number; signal?: AbortSignal }): Promise<void>` — polls until synced (defaults: `timeoutMs` 300000, `pollIntervalMs` 5000, `maxConsecutiveTransientErrors` 3), throwing a typed `KnowledgeBaseTimeoutException` on timeout or propagating `IngestionFailedException` on a failed job. Up to `maxConsecutiveTransientErrors` _consecutive_ transient control-plane errors are tolerated (the counter resets on a clean poll); terminal errors short-circuit immediately. Transient covers both throttling / transient network failures **and** a _not-yet-visible_ knowledge base — during the post-deploy window the control plane can briefly return `ResourceNotFoundException` (the freshly-created KB/data source hasn't propagated yet), which is ridden out rather than treated as terminal; a _missing-KB config_ error (`KB_ID` unset) stays terminal. The poll interval carries ±20% jitter (only the delay between polls varies, never the poll count or the deadline) so many KBs don't poll in lockstep. Pass an optional `signal` (`AbortSignal`) to cancel the wait — checked before each poll and during the inter-poll delay — which rejects with the signal's abort reason (default: a `DOMException` named `'AbortError'`).

  Purely additive — `retrieve()` and all existing signatures are unchanged. The local mock reports synced immediately (no async ingestion window in local dev).

  The umbrella `@aws-blocks/blocks` package now also re-exports the new `WaitUntilSyncedOptions` type (alongside the existing `KnowledgeBase` re-exports) from both its runtime and CDK entry points, so consumers importing from `@aws-blocks/blocks` can reference it directly.

### Patch Changes

- Updated dependencies [b6fb281]
- Updated dependencies [b6fb281]
  - @aws-blocks/bb-knowledge-base@0.2.0

## 0.1.9

### Patch Changes

- Updated dependencies [e839301]
- Updated dependencies [179817f]
  - @aws-blocks/core@0.1.10
  - @aws-blocks/bb-data@0.2.1
  - @aws-blocks/bb-agent@0.3.0

## 0.1.8

### Patch Changes

- Updated dependencies [42fcbdf]
  - @aws-blocks/bb-data@0.2.0

## 0.1.7

### Patch Changes

- Updated dependencies [f946736]
- Updated dependencies [53adfb8]
- Updated dependencies [ce61bb7]
  - @aws-blocks/bb-agent@0.2.0
  - @aws-blocks/bb-auth-oidc@0.1.6

## 0.1.6

### Patch Changes

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

- Updated dependencies [f42c604]
- Updated dependencies [03b971a]
- Updated dependencies [1da34f1]
- Updated dependencies [683bf49]
  - @aws-blocks/core@0.1.6
  - @aws-blocks/bb-auth-oidc@0.1.4
  - @aws-blocks/auth-common@0.1.3
  - @aws-blocks/bb-auth-basic@0.1.3
  - @aws-blocks/bb-auth-cognito@0.1.5
  - @aws-blocks/bb-kv-store@0.1.4

## 0.1.5

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [f24d3c3]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-agent@0.1.3
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-async-job@0.1.2
  - @aws-blocks/bb-auth-basic@0.1.2
  - @aws-blocks/bb-auth-cognito@0.1.4
  - @aws-blocks/bb-auth-oidc@0.1.3
  - @aws-blocks/bb-cron-job@0.1.3
  - @aws-blocks/bb-dashboard@0.1.2
  - @aws-blocks/bb-data@0.1.2
  - @aws-blocks/bb-distributed-data@0.1.2
  - @aws-blocks/bb-distributed-table@0.1.3
  - @aws-blocks/bb-email-client@0.1.3
  - @aws-blocks/bb-file-bucket@0.1.2
  - @aws-blocks/bb-knowledge-base@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2
  - @aws-blocks/bb-metrics@0.1.2
  - @aws-blocks/bb-realtime@0.1.2
  - @aws-blocks/bb-tracer@0.1.4

## 0.1.4

### Patch Changes

- 7fd51e0: fix(bb-auth-cognito): discriminate `SignInResult` on a string `status` field

  `SignInResult` (from `signIn` / `confirmSignIn` / `autoSignIn`) now discriminates
  on a string `status` (`'signedIn' | 'continueSignIn'`) instead of the `isSignedIn`
  boolean, so native-client codegen (Swift / Kotlin / Dart) emits clean, named,
  switch-decoded variants. Narrow with `if (result.status === 'signedIn')`.

  Breaking change to the `SignInResult` shape (pre-release): `isSignedIn` is removed,
  not aliased.

- Updated dependencies [7fd51e0]
- Updated dependencies [e98bab4]
  - @aws-blocks/bb-auth-cognito@0.1.3
  - @aws-blocks/core@0.1.3

## 0.1.3

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- Updated dependencies [835c425]
- Updated dependencies [dd07335]
  - @aws-blocks/bb-agent@0.1.2

## 0.1.2

### Patch Changes

- 7b80811: Add in-repo Building Block docs discoverability.

  The `@aws-blocks/blocks` package now ships a `docs/` folder containing every Building Block README (one per block) plus a generated `index.md` with a decision tree and catalog. This gives humans and AI agents a single, stable path to all block documentation — `node_modules/@aws-blocks/blocks/docs/` — instead of scattering them across 19+ individual package paths.

  - `@aws-blocks/blocks`: adds `docs/` to the published package (assembled at build time via `scripts/sync-block-docs.mjs`). README expanded to be a comprehensive guide (architecture, workflow, best practices, common mistakes).
  - `@aws-blocks/create-blocks-app`: AGENTS.md templates updated to point to the blocks README and docs folder as the canonical entry points.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-auth-cognito@0.1.1
  - @aws-blocks/bb-auth-oidc@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-metrics@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-agent@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-auth-basic@0.1.1
  - @aws-blocks/bb-cron-job@0.1.1
  - @aws-blocks/bb-dashboard@0.1.1
  - @aws-blocks/bb-data@0.1.1
  - @aws-blocks/bb-distributed-data@0.1.1
  - @aws-blocks/bb-email-client@0.1.1
  - @aws-blocks/bb-knowledge-base@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/bb-tracer@0.1.1

## 0.1.0

Initial version
