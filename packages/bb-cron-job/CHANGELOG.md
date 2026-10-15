# @aws-blocks/bb-cron-job

## 0.2.2

### Patch Changes

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
  throw new Error('Todo not found');
  
  // after — status, message, and name all reach the client
  throw new ApiError('Todo not found', 404, { name: 'TodoNotFoundException' });
  ```
  
  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.
- 7b7a59f: fix(bb-cron-job,hosting): scope service-principal grants to the deploying account
  
  - **bb-cron-job**: the EventBridge Scheduler role's trust policy is now limited to
    schedules in the stack's account and region (`aws:SourceAccount` and an `aws:SourceArn`
    schedule-group pattern).
  - **hosting**: removed a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key
    policy. The Origin Access Control wiring already grants CloudFront decrypt on the bucket key,
    conditioned on `AWS:SourceArn` matching the account's CloudFront distributions.
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
  - @aws-blocks/bb-lambda-compute@0.5.1
  - @aws-blocks/bb-logger@0.2.1

## 0.2.1

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`
  
  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.
- d7312f9: test: adapt CDK test doubles to the compute-driven observability contract
  
  Test-only change: both packages' CDK tests use a stub `Compute` that must satisfy
  the `Compute` base class. The compute-driven observability work adds abstract
  observability hooks to `Compute` (`healthWidgets` / `loggingWidgets` /
  `tracingWidgets`, and `applyTracing`), so the stubs now implement them (as no-ops
  that fail the test if the block ever pokes the compute). No runtime or public API
  change.
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
  - @aws-blocks/bb-lambda-compute@0.5.0
  - @aws-blocks/bb-logger@0.2.0

## 0.2.0

### Minor Changes

- 165093b: `CronJob`: validate the schedule (and timezone) at synth so an invalid expression fails fast instead of after minutes of deploy.
  
  The CDK layer passed `schedule`/`timezone` straight into the EventBridge `CfnSchedule` with no validation, so an invalid expression — e.g. `rate(10 seconds)` (EventBridge's minimum is 1 minute) or a malformed `cron(...)` — passed `cdk synth` and was only rejected by EventBridge minutes into provisioning. The mock already validated these, so local dev and deploy diverged.
  
  The schedule parser and timezone check are now a shared `schedule` module used by both the mock and the CDK construct. `CronJob`'s constructor validates up front and throws `CronJobErrors.InvalidSchedule` / `CronJobErrors.InvalidTimezone` at synth, before any infrastructure is created.
  
  The synth gate is deliberately lenient for `cron(...)` — it checks the 6-field shape and defers field-level semantics (`L`/`W`/`#`, year fields, named days) to EventBridge — so it never rejects an advanced-but-valid schedule. The local mock, which must actually simulate the schedule, still can't model those forms; it now throws the new `CronJobErrors.ScheduleNotSupported` (rather than `InvalidSchedule`) for them, so local dev doesn't call a deployable schedule "invalid". No behavior change for valid, mock-supported schedules.
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
  - @aws-blocks/bb-lambda-compute@0.4.0

## 0.1.5

### Patch Changes

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

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.2

### Patch Changes

- 4758fd3: fix(bb-cron-job): respect the upper bound of stepped cron ranges (e.g. `0-30/10`) instead of stepping past it, and reject inverted (`30-10`) or out-of-bounds (`100`, `0-100/5`) field values instead of silently producing empty or invalid schedules

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
