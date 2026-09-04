# @aws-blocks/core

## 0.4.0

### Minor Changes

- c45eb92: Extend stack-wide `BlocksDefaults` (introduced in the Infrastructure Options work) with three additive fields, and adopt them across the Blocks-managed infrastructure. Each field is read independently via `option ?? scope.defaults.field` — a per-block option always wins, and no field is derived from another.
  
  `@aws-blocks/core/cdk` now adds to `BlocksDefaults` (and both `BlocksPresets`):
  
  - `logRetention: RetentionDays` — how long Blocks-managed CloudWatch log groups keep events. Preset sandbox `ONE_WEEK`, production `ONE_YEAR`.
  - `throttling: { rateLimit, burstLimit }` — request-rate limits applied to every Blocks API Gateway stage. Preset sandbox `200 / 400`, production `1000 / 2000`.
  - `accessLogging: boolean` — structured JSON access logs on every Blocks API Gateway stage. **Off by default in both presets** (opt-in), because enabling it mutates the account/region-level API Gateway CloudWatch role singleton.
  
  Also newly exported from `@aws-blocks/core/cdk`: the `BlocksThrottling` type and `ensureApiGatewayAccount()` (provisions the account-level API Gateway CloudWatch Logs role once per stack). `Scope` gains a `handlerLogGroup` getter for the shared handler log group.
  
  **Log retention** — Blocks-managed log groups now follow `defaults.logRetention` instead of AWS's infinite default: the shared handler Lambda (now owned by `BlocksStack`/`BlocksBackend` as `scope.handlerLogGroup`), the `bb-distributed-table` GSI-manager Lambdas, the `bb-distributed-data` DSQL migration Lambda, the `bb-data` Aurora migration Lambda, and the `bb-app-setting` secret-init Lambda. `bb-logger` reconfigures the shared handler group's retention — **only when an explicit per-Logger `retention` is set** (a bare `Logger` no longer writes it back, so it can't clobber another Logger's value) — rather than creating its own `/aws/lambda/<fn>` group. (Note: the framework `custom-resources.Provider` Lambdas these BBs wrap still use AWS's default retention — the L2 `Provider` exposes no log-group/retention override.)
  
  **Throttling** — applied to the core REST API stage and the `bb-realtime` WebSocket stage. On a WebSocket stage the throttle unit is messages/second across the connection.
  
  **Access logging** — when enabled, each stage writes structured JSON access logs to a dedicated CloudWatch log group (retention = `defaults.logRetention`, removal policy = `defaults.removalPolicy` so production **RETAIN**s the audit trail on teardown). The account-level API Gateway CloudWatch Logs role is provisioned once per stack and shared across stages.
  
  **⚠️ Behavior changes on upgrade:**
  - **Throttling now caps the core REST API and WebSocket stages.** Before this change these stages had no stage-level throttle (they ran at the API Gateway account default, ~10k rps). After upgrade, sandbox is capped at 200 rps / 400 burst and production at 1000 rps / 2000 burst. Apps serving above the production ceiling will see `429`s — raise it with a per-stack `throttling` override (`defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`).
  - **The shared handler Lambda log group changes.** The handler previously logged to Lambda's auto-created `/aws/lambda/<fn>` group (infinite retention); it now logs to a framework-owned group with the default retention. On upgrade the old auto group is left orphaned in CloudWatch (unmanaged, still infinite) — delete it manually if you want its history/cost gone. Likewise a `bb-logger`-created retention group from a prior version is replaced.
  - **Access logging** is **opt-in (off in both presets)**. When enabled it requires the account-level API Gateway CloudWatch Logs role — an account/region-level singleton, so enabling it is safe for **one Blocks stack per region** (see `ensureApiGatewayAccount()` for the multi-stack teardown caveat). It defaults off (rather than on for production) so an upgrade never mutates that account-wide singleton without an explicit opt-in.
  - **`BlocksDefaults` gains three required fields** (`logRetention`, `throttling`, `accessLogging`). Apps that spread a `BlocksPresets` preset (the documented path) are unaffected; code that hand-rolls a literal `BlocksDefaults` object will need to add the new fields to compile.
  
  `bb-dashboard` now points its log widgets at the framework-owned handler log
  group (`scope.handlerLogGroup.logGroupName`) instead of reconstructing
  `/aws/lambda/<fn>` — the handler now writes to a dedicated group with a
  CDK-generated name, so the old convention would leave the "Recent Errors" /
  "Log Volume" widgets querying an empty group.
  
  Hosting adoption of these defaults (SSR REST API + compute log groups) ships in a separate change.
- 4a830a6: feat: route event-block resources to their resolved compute
  
  AsyncJob, CronJob, and Realtime now attach their compute-bound resources to a
  compute resolved at synth rather than the stack's shared handler:
  
  - AsyncJob attaches its SQS event source to the resolved compute's function;
  - CronJob points its EventBridge Scheduler target at the resolved compute's function;
  - Realtime binds its shared WebSocket API integrations to the stack's **default**
    compute (its routes are a stack-level singleton) and grants `postToConnection`
    to the shared execution role, so `publish()` works from any compute.
  
  Each block requires a Lambda compute today and fails at synth with a typed
  `UnsupportedCompute` error (assertable via `isBlocksError`) on any other type.
  The check uses a duplicate-copy-safe brand (`LambdaCompute.isLambdaCompute`,
  backed by a `Symbol.for` marker) instead of `instanceof`, so it does not misfire
  when two copies of `bb-lambda-compute` resolve in one dependency tree.
  
  On the default single-Lambda setup the resolved/default compute is the stack's
  default, whose function is the shared handler — so this is non-breaking with no
  change to synthesized infrastructure. AsyncJob also grants SQS send to the shared
  execution role rather than the handler directly.
  
  New public surface (hence `minor`):
  
  - `@aws-blocks/core` exports `blocksError(name, message)` (the producer half of
    the `isBlocksError` contract) and `sanitizeConfigKey(id)` from `./bb-utils`
    (the single env-var-key sanitizer both config writers and runtime readers use).
  - `@aws-blocks/bb-lambda-compute` adds a `./cdk` subpath exposing the CDK-typed
    `LambdaCompute` and its `LambdaCompute.isLambdaCompute` guard.
  - `bb-async-job` / `bb-cron-job` / `bb-realtime` add an `UnsupportedCompute`
    error member.
  
  `@aws-blocks/bb-agent` builds AsyncJob and Realtime internally, so its CDK test
  moves onto the `BlocksStack.create` harness instead of a handler-only stub.
  Test-only change — no runtime behavior change to the Agent.

### Patch Changes

- 64ddd74: refactor(core): retarget the config registry to the shared role and every compute
  
  `finalizeConfigRegistry` no longer takes a single handler function. It now takes
  the owning construct plus the shared execution role and the stack's computes
  (`finalizeConfigRegistry(root, executionRole, computes)`) and:
  
  - grants `s3:GetObject` on the config object **once to the shared execution
    role** instead of to one function's role, so every compute that assumes the
    role can read it; and
  - stamps `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY` on **every compute** via
    `compute.setEnv(...)` rather than on a single hardcoded handler.
  
  Adds a per-stack compute registry (`registerCompute` / `getComputes`): computes
  self-register on their owning stack in the `Compute` base constructor (state
  keyed on the stack, resolved via `cdk.Stack.of()`, like the config registry), so
  a multi-stack synth keeps each stack's computes isolated. `create()` reads the
  registry directly via `getComputes(stack)`.
  
  Behavior-preserving for the default single-compute app: the same config object
  is written to S3, the same two coordinates reach the runtime, and the same
  `s3:GetObject` permission is available — now via the shared role. Internal
  refactor; no public API or runtime-config-loading change.
- 646614b: feat(core): record each API namespace on its resolved compute (internal)
  
  `ApiNamespace` now records its name on the namespace's resolved compute
  (`compute.namespaces`) so later request routing can map a namespace to the
  compute that hosts it. This is a CDK-synth-only internal side effect — in the
  mock/runtime bundles there is no compute and it is a silent no-op.
  
  The public `ApiNamespace(scope, name, handler)` signature is unchanged and the
  returned handler is byte-identical. On the default single-compute app every
  namespace is recorded on the stack's default compute. No `{ compute }` overload
  is added here (that is the later customer-facing surface).
- 1da58fd: `destroySandbox` (used by `npm run destroy` and per-job E2E teardown): empty versioned S3 buckets before retrying `cdk destroy`. Teardown relies on each bucket's `autoDeleteObjects` Lambda, which never provisions if the CREATE failed, so a versioned bucket blocked the delete and the stack (and its IAM roles) leaked. On a destroy failure the buckets owned by the app's stacks are now emptied (all object versions + delete markers, paginated) before the retry, alongside the existing VPC-ENI backoff.
- Updated dependencies [1da58fd]
- Updated dependencies [5960fa4]
  - @aws-blocks/hosting@0.2.1
  - @aws-blocks/pipeline@0.2.1

## 0.3.0

### Minor Changes

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
- f00adb0: feat(core): add `allowedOrigins` to `BlocksDefaults`
  
  `BlocksDefaults` gains an `allowedOrigins` field — CORS origin patterns (matched
  against the request `Origin` header) the compute's API accepts. `LambdaCompute`
  now reads `this.defaults.allowedOrigins` to populate `CORS_ALLOWED_ORIGINS`
  (comma-joined, as the runtime parses it) instead of reading the `sandboxMode`
  CDK context. The `sandbox` preset allows localhost (so a local dev frontend can
  reach a deployed API); `production` allows none.
  
  **Breaking (direct `BlocksDefaults` literal authors only):** `allowedOrigins` is
  required. Building the object from `BlocksPresets.sandbox` / `BlocksPresets.production`
  (or a spread of one) is unaffected — the presets supply it. Only a hand-written
  `BlocksDefaults` literal must add the field.
- 08ab129: Add `pointInTimeRecovery: boolean | { retentionDays: number }` to `BlocksDefaults` (and to `BlocksPresets`: `true` in `production`, `false` in `sandbox`).
  
  This extends the stack-wide infrastructure-defaults posture with the continuous-backup knob, so a Building Block whose service supports it (DynamoDB Point-in-Time Recovery) can resolve its default from `scope.defaults.pointInTimeRecovery` — read independently, the same way as `removalPolicy` and `deletionProtection`. `true` enables backups with the service default window, `false` disables them, and `{ retentionDays: n }` pins the window (the block validates `n` against its service's range) — on/off and window are one field since a window only means anything when backups are on. Blocks whose service has no equivalent simply ignore it. `bb-distributed-table` is the first consumer.
  
  > The property **name** (`pointInTimeRecovery`) and its `{ retentionDays }` shape are a public `@aws-blocks/core/cdk` surface addition and want API-BR sign-off before release.
- 9d4ccea: Add `secret()` / `config()` support to hosting and pipeline for self-hosted deployments — externalized values that are never hardcoded in source, committed to git, or written into the CloudFormation template.
  
  **Two intent functions; the store is implied by which you call.**
  
  - **`secret('KEY')` → AWS Secrets Manager** — for sensitive values (API keys, tokens, credentials).
  - **`config('KEY')` → SSM Parameter Store** (free tier) — for non-sensitive externalized values (feature flags, a custom domain, a connection ARN).
  
  The developer never selects a store; it is derived from the function (`storeForKind`), so the CLI write, the IAM grant, the synth-time fetch, and the runtime read can never disagree.
  
  **Runtime read — two getters, one per store.** `getSecret('KEY')` reads Secrets Manager; `getConfig('KEY')` reads SSM. Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous. Both read `process.env.KEY` first, so **local dev needs no AWS** (put the value in a `.env` file). Values are fetched + decrypted on first use, cached (per-kind `cacheTtlSeconds` for rotation without a cold start; otherwise cached for the process lifetime), and never enter the template. The getters live on the **CDK-free `@aws-blocks/hosting` entry** — the value API (`secret`/`config`/`getSecret`/`getConfig`) is the package's `.`, and its module graph pulls in no CDK, no `fast-glob`, and no `node:fs`, so importing it into an SSR/runtime bundle (including the edge runtime) is safe. Build-time tooling lives off `.` so it never enters a runtime bundle: the CDK construct + resolution engine on `@aws-blocks/hosting/constructs`, and the CLI + typegen engines on `@aws-blocks/hosting/scripts`. (`@aws-blocks/core` already exports a backend `getConfig`, so import the hosting getters from `@aws-blocks/hosting`.)
  
  **CDK wiring.** In `Hosting` `environment` (and `domain`) a `secret()`/`config()` marker injects only the store *locator* and grants the compute role least-privilege read (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to the exact ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`). When a `stage` is set the grant covers BOTH the stage locator `<prefix>/<stage>/<key>` and the shared fallback `<prefix>/<key>` (the fallback read is what lets a stage fall back to a shared value), so treat the shared entry as readable by every stage sharing that prefix. A **synth-time** position — `domain.domainName` — accepts only `config()` (or a plain string), never `secret()`: the value is resolved via an SDK read and **inlined as a literal into the template** (a domain must be a literal before CloudFront/ACM), so a secret there would defeat its own purpose; a domain is public anyway. Synth resolution is async, so use `await Hosting.create(...)`. (Runtime `environment` markers still accept both `secret()` and `config()` — those inject only the locator and never inline.) Per-kind namespace/cache config is set via the separate `secretStore` / `configStore` props (`{ prefix, stage, cacheTtlSeconds }`), defaulting to the neutral `/hosting/secrets` and `/hosting/config` prefixes.
  
  **Namespacing (avoid cross-app collisions).** A **Blocks** app is scoped automatically: the `Hosting` / `Pipeline` blocks and the `npm run secret` / `config` CLIs default to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`, where `stackId` is the app's stable id from the committed `.blocks/config.json`. Both the CLI and the CDK synth read that same file, so two Blocks apps in one account/region never collide, and the write and the read can never diverge (when the file is absent — e.g. a bare test — both sides fall back to the unscoped `/blocks/*` identically). `stackId` is stage-independent (prod and sandbox share it; use the opt-in `stage` segment for per-stage values). A **standalone** hosting/pipeline app (the framework-neutral leaf) has no `.blocks/config.json`, so its defaults (`/hosting/secrets`, `/hosting/config`) stay account-global — give each app its own `secretStore.prefix` / `configStore.prefix` (and matching CLI `--prefix`) when more than one deploys to an account. Use `--region` (or `AWS_REGION`) to write the value in the same region the app deploys to.
  
  **Bring-your-own (BYO).** `environment` (hosting) and `buildSecrets` (pipeline) also accept an existing CDK `ISecret` / `IParameter` handle alongside the managed markers: the construct grants read via the handle and injects its locator, so `getSecret`/`getConfig` resolve it identically — managed *provisions*, BYO *references*.
  
  **Pipeline.** `source.connectionArn` accepts a `config()` marker (resolved to a literal at synth; a connection ARN is a reference inlined into the template, so `secret()` is a type error there — same rule as `domain`). `buildSecrets` accepts `secret()` markers or BYO `ISecret` handles and wires them as CodeBuild `SECRETS_MANAGER` env vars fetched at build time (masked in logs, never inlined) — build-time credentials are secrets, so this surface is Secrets-Manager-only. Namespace config via `secretStore` / `configStore`.
  
  **CLI.** `secret set|list|remove` (Secrets Manager) and `config set|list|remove` (SSM), sharing one engine (`setValue`/`listValues`/`removeValue`/`runValueCli`). Blocks apps get `npm run secret` / `npm run config` (scoped per app to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`); standalone/pipeline apps get the `hosting-secret` and `hosting-config` bins. A **secret** value is never read from argv/shell history — `secret set` takes it from a hidden prompt or `--value-stdin` (a positional value is a hard error); a non-sensitive **config** value may be passed positionally. `list` prints names only, never values. All commands accept `--prefix`, `--stage`, and `--region` (write to the same region the app deploys to).
  
  **Type-safe reads (zero code) — `getSecret` / `getConfig` autocomplete + typo errors.** The runtime getters are typed against two augmentable registries (`HostingSecretRegistry` / `HostingConfigRegistry`): empty by default they accept any `string` (unchanged, non-breaking), and once populated they narrow to your declared keys — editor autocomplete, and a typo (or reading a `config` key via `getSecret`, i.e. the wrong store) becomes a compile error. You populate them with **no code change** via the new `hosting-typegen` CLI (`npm run typegen`, `--watch` to regenerate on save, `--check` for CI): it statically scans your `secret('...')` / `config('...')` calls (TypeScript compiler API — no app execution, no AWS credentials) and generates a `.d.ts` (`.blocks/hosting-values.d.ts`) that augments the `@aws-blocks/hosting` entry (where the getters live), narrowing them to your declared keys. The generated file is derived from your `secret()`/`config()` calls, and `--check` fails CI when it's stale. Add `.blocks/**/*.d.ts` to your tsconfig `include`. In a Blocks app this is automatic: the dev server (`npm run dev`) auto-detects `secret()`/`config()` usage and runs the generate-and-watch step itself (a no-op when the app declares no secrets, and non-fatal), so keys update as you type with no second command; standalone hosting apps use `hosting-typegen --watch`.
  
  **Typed, parsed values via a schema.** `secret('KEY', { schema })` / `config('KEY', { schema })` accept any Standard Schema (Zod, Valibot, ArkType — typed as `StandardSchemaV1`, library-neutral). `typegen` builds a TypeScript `Program`, infers the schema's output type, and inlines it into the generated `.d.ts`, so **`getSecret`/`getConfig` return the inferred type** (e.g. `const { beta } = await getConfig('FEATURE_FLAGS')`) instead of `string` — no `JSON.parse(...)` and no `any`. At runtime the value is JSON-parsed (a per-key flag is injected at synth); the schema itself isn't shipped to the runtime, so this is parse-to-type, not a deep re-validation across the bundle boundary.
  
  **Templates.** `@aws-blocks/create-blocks-app` templates scaffold a `secret` script (`npm run secret`) wired to the Blocks CLI, and a `typegen` script (`npm run typegen` → `runTypegenCli` from `@aws-blocks/blocks/scripts`) with `.blocks/**/*.d.ts` added to the tsconfig `include`, so a newly-created app can manage secrets and get type-safe `getSecret`/`getConfig` out of the box.

### Patch Changes

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
- 5bfae0a: Reject oversized JSON-RPC request bodies at the shared parser. `parseRpcRequest` now caps the body at 10 MiB (`MAX_RPC_BODY_BYTES`, the same limit API Gateway enforces in production) and returns a `413` error named `PayloadTooLarge` before parsing or dispatch. In production API Gateway rejects an oversized body at the edge before the Lambda runs; enforcing the same limit at the parser means the local dev server rejects the same body instead of buffering it and wedging the local database (e.g. PGlite). Because both the Lambda handler and the dev server route through this one parser, the cap lives in a single place, and `decodeRpcResponse` surfaces it client-side as `ApiError.status === 413`.
- 0ac3879: `sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.
  
  Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run a bounded STS `GetCallerIdentity` check up front and, on a real credential error (missing/expired/invalid), exit immediately with guidance (`aws configure` / `aws sso login`, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.
  
  The check is deliberately conservative: it only blocks on a genuine credential error (surfacing the SDK error *name*, never the raw message, which can embed an ARN/account id); a network or service error warns and lets the deploy proceed; and it skips (with a warning) when no region is set in `AWS_REGION` / `AWS_DEFAULT_REGION`, rather than guessing a region in the wrong partition (GovCloud/China). The scaffolded `sandbox` template entrypoint now `.catch`es and exits cleanly, matching `deploy`, so the guidance prints without an unhandled-rejection stack trace.
- e4dac4a: Speed up sandbox deploys with CloudFormation **Express Mode**: `npm run sandbox` now runs `cdk deploy --method direct --express`. Express Mode reports each stack operation complete as soon as the resource's configuration is applied, without waiting for full stabilization — a substantial speedup for the sandbox iteration loop.
  
  This is sandbox-only. The production deploy (`npm run deploy`) is unchanged — it keeps a reviewable CloudFormation change set and full stabilization with automatic rollback. Express Mode disables automatic rollback by default; we keep that default for the throwaway sandbox loop rather than forcing `--rollback`, so a failed sandbox deploy may leave the stack in a failed state until the next deploy.
  
  Observability trade-off: `--method direct` also drops some of the CDK CLI's per-resource progress output (it has no change set to report against), and Express Mode itself returns before resources finish stabilizing. Expect less granular deploy progress for sandbox deploys than the production path emits. Because the deploy returns before stabilization, a resource that is still propagating (e.g. a CloudFront distribution) may not be fully ready on the very first request right after `npm run sandbox` returns; this is an accepted trade for sandbox iteration speed.
  
  Requires an `aws-cdk` CLI new enough to expose `--express`. The CLI dev-dependency floor is bumped to `^2.1138.0`, a version that has the flag (it is not necessarily the version that introduced it).
  
  The sandbox deploy argv is built by the pure, unit-tested `buildSandboxDeployArgs` helper (mirroring the existing `buildCdkDeployArgs` for production).
- Updated dependencies [9d4ccea]
- Updated dependencies [947a1bd]
  - @aws-blocks/hosting@0.2.0
  - @aws-blocks/pipeline@0.2.0

## 0.2.0

### Minor Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.
  
  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).
  
  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)
  
  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.
  
  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.

### Patch Changes

- 5262062: feat(core): add the internal `Compute` abstraction
  
  Introduce the abstract `Compute` base behind a new internal entry point
  (`@aws-blocks/core/cdk/internal`). A compute resolves its owning
  `BlocksStack`/`BlocksBackend` on construction to derive its runtime identity
  (backend entry + stack name). It is framework/test-only — not part of the public
  API, and customers cannot instantiate a compute yet. Concrete computes live in
  their own packages (e.g. `@aws-blocks/bb-lambda-compute`).
- 3614a09: Stop `import.meta.url` from crashing the deployed Lambda. The backend handler is bundled to CommonJS, where `import.meta` is empty, so `fileURLToPath(import.meta.url)` in a handler, a Building Block's `aws-runtime` code, or a dependency became `fileURLToPath(undefined)` and threw at Lambda load (every request 502'd). esbuild only warned, so the broken bundle deployed. The handler bundling now shims `import.meta.url` / `import.meta.dirname` / `import.meta.filename` to their CommonJS equivalents (`pathToFileURL(__filename)`, `__dirname`, `__filename`) — the approach esbuild blesses and Rollup applies by default — so the bundle loads cleanly and a dependency that merely contains `import.meta` no longer trips a build failure. Exposes `blocksNodejsBundling()` from `@aws-blocks/core/cdk` (re-exported by `@aws-blocks/blocks`) so every framework `NodejsFunction` gets the same treatment. Note: inside the bundle these resolve to the bundled output location, not your source tree.
- 5262062: feat: extract `LambdaCompute` into `@aws-blocks/bb-lambda-compute`
  
  The abstract `Compute` base stays in core as a framework primitive; the concrete
  `LambdaCompute` (a `NodejsFunction` fronted by its own API Gateway, assuming the
  shared execution role) moves into a new package, `@aws-blocks/bb-lambda-compute`.
  
  The package is CDK-only and its sole export is internal — customers cannot
  instantiate a compute yet. Nothing in the default path constructs it, so this is
  additive and non-breaking.
- 5071079: fix(core): make `SandboxDisableDeletionProtection` actually disable DynamoDB deletion protection
  
  The mixin duck-typed only on the `deletionProtection` property name, but the
  DynamoDB L1 `CfnTable` behind an L2 `Table` spells it
  `deletionProtectionEnabled` — and the L2 `Table` never re-exposes the prop. As a
  result the mixin silently never matched DynamoDB tables: sandbox stacks synthed
  `DeletionProtectionEnabled: true` and `sandbox:destroy` failed on every
  protected table, because DynamoDB refuses `DeleteTable` while protection is on
  regardless of the CloudFormation `DeletionPolicy`.
  
  The mixin now matches both the `deletionProtection` and
  `deletionProtectionEnabled` spellings, so DynamoDB tables are cleared through
  their L1 and consumers no longer need a local `CfnTable` workaround loop.
  Behavior for other resource types is unchanged: only explicitly-enabled
  protection is flipped, so unprotected resources still omit the property (Aurora
  DB instances continue to synth without `DeletionProtection`).
- 8966cfb: fix(telemetry): detect Render and Taskcluster as CI
  
  Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
  omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
  service; Taskcluster tasks always set the namespaced `TASKCLUSTER_ROOT_URL`.
  Runs on those platforms were therefore reported as real user sessions instead
  of `ci:true`, inflating user metrics. `RENDER` and `TASKCLUSTER_ROOT_URL` are
  now included in both `isCI()` implementations (`@aws-blocks/core` and
  `@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
  bump because it re-exports `@aws-blocks/core`.
- b11a75b: Reject primitive and null JSON-RPC params with the standard Invalid Params error.
- Updated dependencies [940956e]
- Updated dependencies [4981137]
- Updated dependencies [5c58c53]
  - @aws-blocks/hosting@0.1.9

## 0.1.18

### Patch Changes

- cb779c8: feat(core): add a shared Blocks execution role and `Scope.executionRole` getter

  The Blocks stack/backend now provisions one explicit IAM role (with
  `AWSLambdaBasicExecutionRole` attached) that the handler assumes, and exposes it
  as `executionRole`. A new `Scope.executionRole` getter resolves the role from
  any Building Block. Additive and non-breaking: the same handler is created, now
  backed by an explicit role instead of an auto-generated one, with block grants
  sitting on the role's default policy exactly as before.

  Migration note: on an existing deployed stack, upgrading replaces the Lambda
  execution role — CloudFormation deletes the old auto-generated role and creates
  the new `BlocksRole`. This is runtime-equivalent (the same grants re-attach to
  the new role) and needs no action, but a change-set diff will show a role
  delete+create rather than a no-op.

## 0.1.17

### Patch Changes

- b48aaec: Route the 504 timeout response's CORS headers through the allowlist-validated `buildCorsHeaders` helper instead of reflecting the request `Origin` (with a `'*'` fallback) alongside `Access-Control-Allow-Credentials: true`. Disallowed origins now get no CORS grant on timeout. Also lowers `Access-Control-Max-Age` from `86400` to `7200` on OPTIONS preflights and in the dev server, since browsers cap preflight caching well below 86400.

  Adds `Vary: Origin` to every CORS response (Lambda and dev server) so shared caches key on the request origin and can't serve one origin's `Access-Control-Allow-Origin` grant to another. The `7200` value is now the single exported `CORS_MAX_AGE` constant, and the disallowed-origin warning logs once per distinct origin instead of once per request.

- ac0966a: docs: correct default local dev port to :3000/aws-blocks/api
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

- 8e96d87: Return a JSON usage hint instead of an empty body when a dev-server request doesn't match `POST /aws-blocks/api`. Opening the endpoint in a browser (a GET) or hitting a REST-style URL previously returned a bare 404 with no body; it now responds with `{ error, expected: { method: 'POST', path: '/aws-blocks/api' } }`, and says so explicitly when the path was right but the method was wrong.
- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- 2d3dfdc: Remove the redundant `--hotswap` flag from the `cdk watch` invocation in `npm run sandbox`. `cdk watch` already performs hotswap deployments by default, so passing the flag explicitly was redundant and emitted a duplicate-option warning on some `aws-cdk` CLI versions.
- Updated dependencies [0284e5b]
  - @aws-blocks/hosting@0.1.8

## 0.1.16

### Patch Changes

- b09e568: Add a SvelteKit framework adapter. SvelteKit apps are now auto-detected (via
  `@sveltejs/kit`) and deployed through `@sveltejs/adapter-node` running on Lambda
  behind the Lambda Web Adapter (the existing `http-server` compute path), fronted
  by CloudFront + S3. Supports SSR pages, `+server.js` endpoints, form actions,
  server `load`, `hooks.server`, streaming, prerendered/SSG pages (served frozen
  from S3), custom headers, cookies, redirects, `error()`, and `paths.base`. A
  transparent build bridge wires `@sveltejs/adapter-node` when the app hasn't
  configured it, so no manual setup is required. Patch (not minor) per the
  pre-1.0 caret convention — the change is additive and backward-compatible.
- Updated dependencies [b09e568]
  - @aws-blocks/hosting@0.1.7

## 0.1.15

### Patch Changes

- 1f1287e: Never serve a stale placeholder `config.json` after a deploy. The build-time placeholder (`{"_placeholder":true}`) was uploaded with the 1-year mutable cache-control (`public, s-maxage=31536000, max-age=0, must-revalidate`), and the post-deploy CloudFront invalidation targeted `/.blocks-sandbox/*` — which never matches the real cache key, because the skew-protection viewer-request function rewrites the URI to `/builds/<buildId>/.blocks-sandbox/config.json` before the cache lookup. An edge that cached the placeholder during the deploy window could keep serving it for up to a year, making `getApiUrl()` throw and every client API call fail. The placeholder is now registered as a no-cache path (`no-cache, no-store, must-revalidate`) so edges never cache it long-term, and the config deployment now also invalidates the post-rewrite key `/builds/<buildId>/.blocks-sandbox/*`.

## 0.1.14

### Patch Changes

- fc33428: fix(telemetry): inherit worker stderr in debug mode; enable telemetry in CI for create-blocks-app

  - When `NODE_DEBUG=blocks-telemetry` is set, the telemetry worker subprocess
    inherits the parent's stderr so delivery confirmation is observable. Silent
    by default.
  - Remove CI telemetry suppression from create-blocks-app to match core behavior.
    Telemetry is now enabled in CI (same as all other CLI commands).
  - Make `console` cross-platform and headless-safe: pick the OS browser opener
    (`open`/`xdg-open`/`start`), resolve the region from the environment, and treat
    a missing opener (CI / remote shells) as best-effort success instead of failing.
  - Add an isolated E2E telemetry test suite (`test-apps/telemetry`) that verifies
    payload structure, delivery to the real endpoint, disable mechanisms, and
    per-command success/failure events.

## 0.1.13

### Patch Changes

- a7427d4: Prevent verbose local RPC logging from turning successful void handlers into error responses.

## 0.1.12

### Patch Changes

- 71eb746: Fix eleven reproducible hosting issues:

  - **Astro SSR `/_image` content-type**: the SSR bundle now ships a linux-x64 `sharp` (installed post-build into `dist/server/node_modules`, wasm fallback pruned, ~19.5 MB), so Astro's default `sharp` image service works on Lambda and `/_image` returns a real optimized image with a correct MIME (`image/png`/`image/webp`) instead of the `noop` passthrough's `content-type: image/null`. Gated on the app using the sharp service; apps that pick `noop`/custom are skipped. A dedicated image Lambda isn't feasible for Astro (it fuses `/_image` into the SSR bundle via the `astro:assets` virtual module, unlike Nuxt IPX / OpenNext).

  - **Next image optimizer on Next 15.x**: the `fetchInternalImage` arity patch was gated on an inverted version assumption (the `maximumResponseBody` parameter was added in Next 16, not 15.5). It now only applies on Next ≥ 16, so local image optimization no longer 500s on Next 15.x apps. Renamed `patchImageOptimizerForNext155` → `patchImageOptimizerForNext16`.
  - **Image optimizer on disallowed types (SVG)**: an untrusted SVG (with `dangerouslyAllowSVG` disabled) now fails closed with its real `400` status instead of a blanket `500` — OpenNext was catching Next's 400 in a generic block that discarded the status.
  - **SPA hashed assets**: the SPA adapter now marks Vite's content-hashed `assets/*` bundles `immutable` (`immutablePaths: ['assets/*']`) instead of leaving them in the revalidation-only cache tier.
  - **Missing static assets**: the OAC bucket policy now grants `s3:ListBucket` so a missing key returns a clean `404 NoSuchKey` instead of leaking `403 AccessDenied` XML to the viewer.
  - **RSC prefetch cache efficiency**: the SSR cache policy excludes Next's random `_rsc` prefetch query param from the cache key (`denyList('_rsc')`), so prefetches of the same page share one edge cache entry.
  - **Wildcard redirects**: Next `:path*` named-catch-all redirects are now lifted to the edge router (converted to `/*`), with a bare-prefix companion redirect, so they no longer leak the literal `:path*` token in `Location`.
  - **Route-table budget**: `TooManyRoutesError` now names which table (routes/redirects/headers) exceeded the budget and calls out `trailingSlash: true` as the likely driver, and the previously-hardcoded 64-chunk cap is now tunable via the `quotas.maxRouteChunks` hosting prop (default 64) for very large sites with measured edge-function headroom.
  - **Nuxt ISR/SWR on-demand pages**: when ISR/SWR is active (`manifest.cache` set), route coalescing now folds a prerendered static sibling group into a single `parent/*` **compute** wildcard (instead of a static one), so a non-prebuilt on-demand child renders at the SSR Lambda instead of hard-404ing from S3 — while the route table stays bounded (one row per parent), avoiding the CloudFront-Function compute-limit 503 a non-coalesced fan-out would cause.
  - **CloudFront S3-origin policy**: every behavior whose origin is S3 — the default behavior AND the edge-route (`runtime: 'edge'`) behavior — now uses a synthesized custom origin request policy instead of the managed `ALL_VIEWER_EXCEPT_HOST_HEADER`, which CloudFront rejects on S3 origins (`InvalidRequest` at distribution create). The sentinel behaviors keep the managed policy (their origins are the tagged server/image custom origins, not S3). A regression guard asserts no S3-origin behavior references a managed origin request policy.
  - **Nuxt IPX remote images**: the IPX image Lambda now rides the shared SSR API Gateway (via a dedicated `<baseURL>/{proxy+}` resource) instead of an OAC Function URL, so an unencoded `://` in a remote source path no longer breaks SigV4 (was `403 InvalidSignatureException`); and the IPX runtime is configured with `httpStorage` scoped to the allowlisted domains so allowlisted remote images resolve instead of `404 IPX_RESOURCE_NOT_FOUND`.

- Updated dependencies [71eb746]
- Updated dependencies [71eb746]
  - @aws-blocks/hosting@0.1.5

## 0.1.11

### Patch Changes

- 76e1e50: fix(core): robust dev server — startup port reclaim, singleton guard, and :3000 EADDRINUSE handling

  Hardens the local dev server against the port-contention failure modes that
  survived PR #80 (which fixed only single-supervisor frontend self-restart):

  - **Startup reclaim** — a fresh `server.ts` now frees a stale `:3000`/`:3100`
    listener left by a crashed or `SIGKILL`'d predecessor before it binds the
    front door / spawns the `--strictPort` frontend, instead of relying on the
    previous process's `cleanup()` finishing within tsx-watch's ~5s window.
  - **Singleton guard** — a per-port pidfile stops a second `npm run dev` from
    spawning a competing supervisor that fights the first over `:3000`/`:3100`; it
    exits cleanly with a clear message. A stable-parent (`tsx watch`) carve-out
    keeps hot reload working, and a dead-owner pidfile never blocks startup.
  - **`:3000` EADDRINUSE robustness** — the backend front door now emits a real
    console error (not only telemetry), reclaims the stale owner and retries the
    bind (bounded), and exits non-zero with a clear message on unrecoverable
    failure, so a contended `:3000` never silently fails to serve.

  Reuses the existing `waitForPortFree` / process-group-kill primitives (plus an
  `lsof`/`netstat` listener probe mirroring the `cleanup` script) — no new
  teardown mechanism. `--strictPort` is retained for local dev, made safe by the
  startup reclaim guaranteeing `:3100` is free first.

## 0.1.10

### Patch Changes

- e839301: fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

  The external-database connection string was stored in an SSM parameter named only
  by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
  the same AWS account + region + stage computed the same name and silently
  overwrote each other's credentials.

  The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
  single new `getStackName({ sandbox, projectRoot })` helper that is also the one
  place the CDK templates compute the stack name (replacing logic duplicated across
  templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
  from `getStackName({ sandbox, projectRoot })` — is used
  by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
  synth, so the written name and the read name are derived once, from committed
  config (`.blocks/config.json`) — never from the connection string — and cannot
  diverge. The name is computable before synth (enabled by the committed stackId from
  PR #51), so no post-deploy write-back or staging-copy machinery is needed.

  The previous stage-only parameter is orphaned and self-heals on the next deploy.

## 0.1.9

### Patch Changes

- 9075b81: Fix four hosting correctness bugs:

  - **Base path is now a first-class `Hosting` prop, and Nuxt `app.baseURL` is modelled.** Added a caller-declared `basePath` option to `Hosting` (e.g. `{ basePath: '/app' }`) — the recommended, framework-agnostic source of truth that CloudFront behaviors are prefixed with (plus a root→`/<basePath>/` 308 redirect). When the prop is omitted, the Nitro adapter now detects Nuxt's `app.baseURL` from the build output and sets `manifest.basePath` (parity with Next `basePath` / Astro `base`); previously it was silently dropped, so a Nuxt app with a base path deployed broken — pages rendered but their hashed `/<base>/_nuxt/*` assets 404'd (no hydration). If a base path is detected in the prerendered output but can't be read, synth fails loud instead of shipping a broken site.
  - **Per-pattern header rules delegate to the SSR runtime instead of competing for CloudFront behavior slots.** For SSR (compute) deploys, a header rule whose pattern has no dedicated behavior is no longer wired as its own CloudFront behavior — the request falls through to the catch-all SSR Lambda, which already emits the framework's `headers()` / `routeRules` at runtime (CloudFront caches the response including those headers). This removes redundant behaviors that burned the scarce ~25-behavior budget and re-asserted a header the origin already sets, and it means SSR header rules can never trip the behavior cap. For **static-only** deploys (S3 origin, no runtime to emit the header) the cap still applies: a rule that would exceed it throws if it sets a security header (CSP, HSTS, X-Frame-Options, … — a lost CSP otherwise looks like a successful deploy) and is dropped with a warning if it's cosmetic.
  - **config.json deploy ordering is now wired correctly.** The resolved `config.json` deployment now depends on the asset deployments so the build's placeholder config can't clobber it. The previous `tryFindChild('AssetDeployment')` never matched the real child ids and the dependency was silently never created.
  - **AWS service quotas are now centrally accounted, configurable, and degrade gracefully.** A new `QuotaBudget` module centralizes the previously-scattered, hardcoded limits (CloudFront cache behaviors, Lambda@Edge associations, and the account-wide response-headers-policy quota — the last of which was previously unguarded and blew up opaquely at deploy time). Three things change:
    - **Configurable:** a new `quotas` prop on `Hosting` (`{ cacheBehaviors?, edgeFunctions?, headerPolicies? }`) lets accounts that have been granted a Service Quota increase raise the corresponding ceiling, instead of hitting a hardcoded throw at the AWS default. Each field documents that synth cannot verify the real granted quota, so an over-set value just moves the failure to deploy time.
    - **Graceful degradation (SSR):** when prerendered pages would exceed the behavior budget on a compute deploy, the lowest-priority pages are demoted to the SSR runtime (served by the catch-all Lambda) instead of failing the build — deterministically, and never touching hashed-asset prefixes, edge routes, image-opt, or non-default compute origins.
    - **Grouping (static-only):** when co-located sibling pages would exceed the budget on a static deploy (no runtime to demote to), they collapse into one `<parent>/*` behavior — lossless, since every path under the parent resolves from S3 either way.
    - **Deploy-fail guards for hard limits:** the static-asset upload Lambda (CDK's `BucketDeployment`) is now sized to 1024 MB / 1024 MiB `/tmp` (up from CDK's 128 MB / 512 MiB defaults, which large sites silently overran with an opaque CloudFormation failure), overridable via `storage.deployment`. Synth also now emits a warning as a stack approaches CloudFormation's hard 500-resource-per-stack limit, so the operator can split the stack before a deploy fails opaquely.

- Updated dependencies [9075b81]
  - @aws-blocks/hosting@0.1.4

## 0.1.8

### Patch Changes

- e9dc073: fix(telemetry): send events via detached subprocess to prevent dropped events

  Telemetry events are now sent via a detached background subprocess instead of
  an in-process https.request. This ensures events are delivered even when the
  parent CLI process exits on failure paths before the socket flushes.

## 0.1.7

### Patch Changes

- 6eb731a: fix(dev-server): auto-respawn frontend and kill the whole process group on restart

  The dev server spawns the frontend (Vite) with `shell: true`, making the real
  Vite process a **grandchild** (shell → npx → node vite). On a `tsx watch`
  restart, cleanup sent `SIGTERM` to only the shell parent, orphaning the Vite
  grandchild — it survived still bound to `:3100`. The freshly launched Vite then
  hit `--strictPort`, failed to bind, and exited; the `exit` handler only logged,
  so `/` served a permanent `502 Frontend server unavailable` with no recovery.

  Fixes:

  - **Process-group kill** — the frontend is spawned `detached` on POSIX (its own
    process group) and cleanup/restart now signal the entire group via
    `process.kill(-pid, …)`, reaping the Vite grandchild and freeing `:3100`.
    Windows (no POSIX groups) reaps the tree with `taskkill /T /F /PID <pid>`,
    which walks the child tree by PID so the Vite grandchild is killed too; it
    degrades to a direct child kill only if `taskkill` cannot be spawned.
  - **Bounded auto-respawn** — an unexpected frontend exit now respawns Vite with
    exponential backoff, capped at 5 restarts / 10s to avoid hot loops, and is
    suppressed during intentional shutdown via an `isShuttingDown` guard. The
    budget counts only _consecutive failing_ restarts: it resets only when **our
    own** freshly spawned child is the process now bound to the port. A liveness
    probe alone cannot tell our Vite from a foreign listener (a leftover Vite or a
    second dev server), and crediting a foreign one would make every
    `--strictPort`-failing respawn look successful, neutralizing the cap and
    hot-looping forever. A frontend that legitimately restarts many times (e.g.
    editor-triggered full reloads) is still never permanently left down. Before
    each relaunch the supervisor now also waits (bounded) for `:3100` to be
    released — the same port-free drain the graceful shutdown path uses — so a slow
    socket teardown can't hand the relaunched `--strictPort` Vite an `EADDRINUSE`
    and burn a restart-budget slot; that wait re-checks the `isShuttingDown` guard,
    so a shutdown arriving mid-wait still cancels the relaunch (and the budget is
    debited once, at exit time, so the wait never double-counts a restart).
  - **Robust shutdown** — cleanup is idempotent, wired to `SIGINT`/`SIGTERM`/
    `SIGHUP`, removes its own listeners, and waits (bounded) for the group to die
    **and for `:3100` to actually be released** before exiting: SIGTERM→SIGKILL
    escalation, then a port-free poll that runs on _both_ the live and the
    already-exited paths (the post-exit path previously skipped it, so a relaunch
    could race the kernel's socket teardown into `--strictPort` `EADDRINUSE`). A
    synchronous `process.on('exit')` safety net remains for paths that bypass
    cleanup — now routed through the shared tree-kill so it reaps on Windows
    (`taskkill`) too instead of early-returning and leaking the Vite tree.
  - **Consistent post-exit reaping** — the failure being fixed is the _shell
    exiting while the detached grandchild survives_, so every post-exit path
    (the respawn handler, graceful shutdown, and the `exit` safety net) now
    issues one best-effort process-group kill even after the shell has gone,
    rather than skipping it. A surviving grandchild keeps the group's id reserved
    on POSIX, so `process.kill(-pid)` still targets our own group; the kills are
    issued synchronously on observing the exit to keep the PID-reuse window
    minimal. The single rationale lives next to the supervisor as the
    "POST-EXIT GROUP-KILL POLICY" so all three sites stay in agreement.
  - **Sandbox entrypoint parity** — `sandbox.ts` (the sibling dev entrypoint) now
    spawns **both** long-running children — the dev server _and_ `cdk watch` — in
    their own process groups and `await`s a bounded group teardown for each
    (run concurrently) on `SIGINT`/`SIGTERM`, replacing the synchronous
    `cdkWatch.kill()` + single dev-server `kill()` + `process.exit(0)` that
    signalled only the npx/shell parents and exited immediately. A bare
    `cdkWatch.kill()` could orphan the real `cdk watch` node process
    (npx → cdk → node) — the same shell-only-kill leak this PR fixes for the dev
    server — so it now routes through the shared `terminateProcessTree` too. Only
    the dev-server drain (the longer 6s budget) owns the `:3100` port-free wait, via
    its own SIGTERM handler, so the next `npm run sandbox` no longer races a
    survivor on `:3100`.
  - **Single tree-kill primitive** — the POSIX group-kill, the Windows `taskkill`
    tree-kill, and the bounded SIGTERM→SIGKILL teardown now live in one shared
    `process-tree.ts` module used by every entrypoint (dev server, respawn
    handler, `exit` net, and sandbox), so the reaping behavior can no longer drift
    between hand-rolled copies. Its bounded teardown documents that its boolean
    reflects only the **direct child's** exit (not whole-group teardown or port
    release — callers needing a freed port must follow with `waitForPortFree`), and
    its post-SIGKILL grace is a named `KILL_GRACE_MS` constant kept deliberately
    shorter than the injectable SIGTERM grace (SIGKILL is uncatchable, so only a
    brief beat is needed to observe the exit).

  `--strictPort` is intentionally retained: the proxy target is hardcoded to
  `:3100`, so the port is reliably freed rather than letting Vite drift to another
  port the proxy wouldn't follow.

- a40e840: fix: bind dev server to all interfaces (0.0.0.0) for WSL2 compatibility

## 0.1.6

### Patch Changes

- f42c604: fix: generate unique stackId in .blocks/config.json, export getStackId/getSandboxId from @aws-blocks/blocks/scripts

  Stack names are now derived from a `stackId` in `.blocks/config.json`, generated at scaffold time as `<name>.slice(0,16)-<random6>`. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts` — no more inline filesystem logic in `index.cdk.ts`.

  Production: `<stackId>-prod`
  Sandbox: `<stackId>-<username(8)>-<random(6)>` (per-machine, gitignored)

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

## 0.1.5

### Patch Changes

- 162c47d: fix(hosting): stop hardcoding image-optimization Lambda reserved concurrency

  The image-optimization Lambda hardcoded `reservedConcurrency: 10`, which made `cdk deploy` fail on fresh AWS accounts (the default account-level unreserved-concurrency limit is also 10, so reserving all 10 drops the account below its required minimum and Lambda returns a 400). It now defaults to no reservation and exposes `compute.imageOptimization.reservedConcurrency` so operators with headroom can still cap it.

- Updated dependencies [162c47d]
  - @aws-blocks/hosting@0.1.3

## 0.1.4

### Patch Changes

- a306ff1: Serve `/.blocks-sandbox/config.json` from the dev server itself instead of proxying it to the framework dev server.

  The browser auth client resolves its API URL by fetching `/.blocks-sandbox/config.json`. The dev server proxied that request to the framework dev server (Next.js/Nuxt/Astro), which only serves its own static dir and returned 404 — so the client failed with "Blocks API URL not configured" in local `dev`. The dev server now answers this reserved path directly, mirroring production where CloudFront serves `/.blocks-sandbox/*` as static assets. Framework-agnostic and requires no per-app workaround.

## 0.1.3

### Patch Changes

- e98bab4: feat(pipeline): extract Pipeline construct into @aws-blocks/pipeline package, add partialBuildSpec for CodeBuild runtime control

  `@aws-blocks/core` receives a minor bump (not patch): it gains a new runtime dependency on `@aws-blocks/pipeline` and adds new public re-exports from its CDK entrypoint (`__PIPELINE_STAGE_SCOPE__`, `Pipeline`, `DeployStage`, and the pipeline configuration types). New backwards-compatible public surface is a minor change per semver.

- Updated dependencies [e98bab4]
  - @aws-blocks/pipeline@0.1.1

## 0.1.2

### Patch Changes

- 18880ff: Fix `deploy`, `sandbox`, and `destroy` failing on Windows: spawn `npm`/`npx`/`cdk` via `cross-spawn` (resolves the `.cmd` shims) and import the backend through a `file://` URL so absolute paths like `D:\...` work during CDK synth.

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/hosting@0.1.1

## 0.1.0

Initial version
