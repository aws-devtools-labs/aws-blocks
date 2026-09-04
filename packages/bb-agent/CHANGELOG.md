# @aws-blocks/bb-agent

## 0.4.0

### Minor Changes

- 9111c0c: feat(bb-agent): cap model and tool calls per turn to bound runaway cost
  
  Adds two per-turn safety caps to `AgentConfig`, both defaulting to `20`:
  
  - `maxLlmCalls` — the maximum number of model (Bedrock) invocations in a single
    turn. Model calls are the unit Bedrock bills for, so this is the most direct
    guard against an agent that loops its reason→act cycle indefinitely; because
    every tool round needs a model call, it transitively bounds tool loops too.
  - `maxToolIterations` — the maximum number of tool calls in a single turn
    (parallel tool batches count each call).
  
  When either cap is exceeded the turn is cancelled and the client receives an
  `error` chunk (so `complete()` rejects) instead of `done`. Both caps are
  enforced with in-loop Strands hooks, so they work identically on every compute
  target with no cross-process signaling.
  
  Behavior change: turns are now capped at 20 model calls and 20 tool calls by
  default. This is generous for a single turn, but agents that legitimately reason
  over many steps or chain many tools must raise `maxLlmCalls` /
  `maxToolIterations`, or set a cap to `false` to disable it. The caps bound call
  *count*, not tokens or wall-clock — pair them with a billing or CloudWatch alarm
  on Bedrock spend for real cost protection.
  
  This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior. The two options are
  new and optional and there's an opt-out (raise the cap, or set it to `false`),
  but the new default changes the runtime behavior of every existing agent — a
  turn that legitimately exceeds 20 model or tool calls is now cut off unless the
  customer opts out — so it ships as `minor` rather than `patch` to surface that
  clearly. The counts cover a whole logical turn: they live in the agent's
  persisted session state, and the per-turn reset is keyed on a turn id applied
  lazily (the session snapshot is restored inside `stream()`, so an up-front reset
  would be overwritten and the budget would leak into the next turn), so a turn
  paused on a human-in-the-loop interrupt keeps its budget across `resume()` while
  a new message always starts a fresh one. A cap value must be a positive integer
  or `false`; anything else throws `InvalidModelConfigException`. The umbrella
  `@aws-blocks/blocks` gets the same bump because it re-exports `AgentConfig`.
- 2cb9d74: refactor(bb-agent): remove inert `structuredOutput` field from `AgentConfig`
  
  `AgentConfig` declared `structuredOutput?: z.ZodType`, but the field was never
  implemented, read, or consumed anywhere — no JSDoc, no consumer, no docs, no
  tests. It advertised a capability that does not exist, so setting it was a silent
  no-op. The declaration is removed (along with its line in the generated
  `API.md` report); no runtime behavior changes, because nothing ever read it.
  
  Structured output remains a planned future LLM-BB feature, tracked separately.
  This change only deletes the dead placeholder surface — it does not add or design
  any real structured-output support.
  
  This is a `minor` bump. Removing a property from an exported interface is a
  breaking change to the public type surface, but every package here is pre-1.0,
  where this repo's convention is that `minor` — not `major` — is the signal for a
  breaking or behavior-altering change (see the `maxLlmCalls`/`maxToolIterations`
  caps, which shipped as `minor` for exactly that reason). Practically the blast
  radius is a compile error only: code that set `structuredOutput` was already
  getting no-op behavior, so the error points at configuration that never did
  anything and the fix is to delete it. The umbrella `@aws-blocks/blocks` gets the
  same bump because it re-exports `AgentConfig`.

### Patch Changes

- d8a3901: Improve the local-dev `canned` provider's tool support with two optional tool hints (ignored by real providers) and schema-default awareness:
  
  - `cannedExamples` — realistic tool input, shallow-merged over generated placeholders instead of the generic `sample` values.
  - `cannedTriggers` — extra keyword phrases that trigger a tool beyond its name (single- and multi-word phrases match on word boundaries, so `'log in'` won't fire on `"backlog in"`; internal whitespace is flexible).
  - Generated placeholder input now respects schema `default` values (from Zod `.default()`).
  
  Also fixes three pre-existing rough edges in the same provider:
  
  - Generated input now resolves `const`, `enum`, and `anyOf`/`oneOf` (Zod union) properties. Previously a property that was a union, a const, or untyped and carried no `default` matched no branch and was dropped — and a *required* field of that shape made the emitted call fail schema validation before the tool ran. A required field of an otherwise unrecognized shape now falls back to a string; optional ones stay omitted, since absence is valid there.
  - The canned *text* responses (`weather`/`order`/`help`) now match on word boundaries like tool matching does, so `"reorder"` no longer returns the order response and `"helper"` no longer returns the help response.
  - A `cannedExamples` key that isn't a field of the tool's schema now logs a one-time warning naming the tool and field, since it is almost always a typo. It never throws and the value is still sent — a bad hint must not break local dev.
  
  Patch (not minor) per the pre-1.0 caret convention — the change is additive and backward-compatible.
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
- Updated dependencies [64ddd74]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6
  - @aws-blocks/bb-realtime@0.2.0
  - @aws-blocks/bb-distributed-table@0.1.7
  - @aws-blocks/bb-async-job@0.2.0
  - @aws-blocks/bb-file-bucket@0.1.6

## 0.3.5

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
- Updated dependencies [ca8cfb6]
- Updated dependencies [08ab129]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-async-job@0.1.5
  - @aws-blocks/bb-distributed-table@0.1.6
  - @aws-blocks/bb-file-bucket@0.1.5
  - @aws-blocks/bb-realtime@0.1.5
  - @aws-blocks/bb-logger@0.1.5

## 0.3.4

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [406ba89]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-distributed-table@0.1.5
  - @aws-blocks/bb-realtime@0.1.4
  - @aws-blocks/bb-async-job@0.1.4
  - @aws-blocks/bb-file-bucket@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.3.3

### Patch Changes

- feb5be4: Regenerate the API report to match the current `BedrockModels` source (the committed `API.md` had drifted from the model-id constants). No source or runtime change.
- Updated dependencies [5b2aede]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [bd59e60]
- Updated dependencies [f583c75]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/bb-distributed-table@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-file-bucket@0.1.3
  - @aws-blocks/bb-async-job@0.1.3
  - @aws-blocks/bb-logger@0.1.3

## 0.3.2

### Patch Changes

- c4313cd: Fix `ERR_MODULE_NOT_FOUND` on a fresh `create-blocks-app` scaffold by making required runtime packages real dependencies of the block that actually loads them. npm does not install peer dependencies of transitive dependencies, so these never landed in `node_modules`.

  - `kysely` → dependency of `@aws-blocks/data-common`. `data-common` is the only package that imports and instantiates `kysely` (in its Kysely adapter); `bb-data` and `bb-distributed-data` merely re-export `createKyselyAdapter` and keep `kysely` as a peer, which is now satisfied transitively via `data-common`. Promoting it on `data-common` alone guarantees a single hoisted instance and installs it for any app that pulls a data block.
  - `@opentelemetry/api` → dependency of `@aws-blocks/bb-agent`. It is a non-optional peer of `@strands-agents/sdk`, which the Agent block loads at runtime, so it must be installed whenever `bb-agent` is present.

  Both packages have zero runtime dependencies and no install scripts, so this adds no transitive tree.

- 997c736: Lazy-load the Strands SDK in the Agent block so that importing `@aws-blocks/blocks` no longer eagerly loads `@strands-agents/sdk` and its non-optional `@modelcontextprotocol/sdk` / `@opentelemetry/api` peers.

  The `@aws-blocks/blocks` umbrella re-exports `Agent` statically, so a fresh scaffold that never instantiates an agent previously failed on the first `npm run dev` with `ERR_MODULE_NOT_FOUND` for those packages. The Strands runtime is now imported on first agent execution (via a cached dynamic `import()`), so it stays off the module **load path** of apps that don't use an agent — those apps run without the packages installed.

  Scope / follow-up: this removes the packages from the _load path_, not from the _install set_. Apps that actually use an Agent block still need `@strands-agents/sdk`'s non-optional peers (`@modelcontextprotocol/sdk`, `@opentelemetry/api`) installed, because Strands imports them when it loads on first agent execution and npm does not auto-install peers of transitive dependencies. Those are supplied to agent-using apps by the Agent scaffold template (and documented for manual installs) rather than promoted to `dependencies` here, which would pull Strands' ~10 MB transitive tree into every app. No public API change.

## 0.3.1

### Patch Changes

- cfe6cb0: fix(bb-agent): use the Lambda execution region for S3Storage (#120)

  The deployed Agent constructed Strands' `S3Storage` without a `region`, so it defaulted to `us-east-1` and hard-pinned the snapshot S3 client there. Because the session bucket is created in the deploy region, any deployment outside `us-east-1` failed snapshot reads/writes with a cross-region 301 `PermanentRedirect`. `S3Storage` is now constructed with `region: process.env.AWS_REGION` — which the Lambda runtime always sets to the function's region — so snapshots resolve against the correct regional endpoint. `region` and `s3Client` are mutually exclusive in `S3StorageConfig`, so only `region` is passed.

## 0.3.0

### Minor Changes

- 179817f: feat(bb-agent): make model config optional, default to BedrockModels.BALANCED

  The `model` field in AgentConfig is now optional. When omitted, the agent
  defaults to `BedrockModels.BALANCED` for deployment and the canned provider
  for local development.

### Patch Changes

- Updated dependencies [e839301]
  - @aws-blocks/core@0.1.10

## 0.2.1

### Patch Changes

- c6ba244: fix(bb-agent): add toJSON() to AgentStreamResult

  `AgentStreamResult` now serializes to `{ channelId, channel: null }` when returned from API methods. Previously `channel` serialized to an empty object `{}`; it is now explicitly `null` to signal it is server-side only.

## 0.2.0

### Minor Changes

- ce61bb7: refactor(bb-agent): capability-based model presets with global inference profiles

  New presets:

  - `BALANCED` (Claude Sonnet 4.6): recommended default for most workloads
  - `SMART` (Claude Opus 4.8): highest capability for hardest tasks
  - `FAST` (Claude Haiku 4.5): lowest latency

  All presets use `global.` inference profiles for region-agnostic deployment.

  Deprecated (non-removing): `DEFAULT` resolves to `BALANCED`, `BUDGET` and `MICRO` resolve to `FAST`. Note this changes the underlying model for existing callers — `DEFAULT` moves from Opus to Sonnet, and `BUDGET`/`MICRO` move from Amazon Nova Pro/Lite to Claude Haiku, so cost and latency profiles differ. The symbols still resolve (no type break), but migrate to `BALANCED`/`FAST` (or a region-scoped profile) explicitly to pin the model you want.

### Patch Changes

- f946736: fix(bb-agent): treat empty channelId as unset in stream()

  An empty `channelId` now falls back to `conversationId` or a random UUID, preventing all streams from sharing the same channel. Empty strings are treated as unset rather than used literally.

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-async-job@0.1.2
  - @aws-blocks/bb-distributed-table@0.1.3
  - @aws-blocks/bb-file-bucket@0.1.2
  - @aws-blocks/bb-logger@0.1.2
  - @aws-blocks/bb-realtime@0.1.2

## 0.1.2

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- dd07335: fix(bb-agent): simplify Bedrock health check to support all inference profile formats

  Removed the prefix regex that determined whether to call `GetInferenceProfile`
  or `GetFoundationModel`. The health check now tries both APIs sequentially —
  any model ID format (cross-region, global, or foundation model) works without
  maintaining a prefix allowlist.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
