# @aws-blocks/bb-async-job

## 0.1.5

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
- Updated dependencies [5798492]
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
  - @aws-blocks/bb-distributed-table@0.1.6
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
  - @aws-blocks/bb-distributed-table@0.1.5
  - @aws-blocks/bb-logger@0.1.4

## 0.1.3

### Patch Changes

- f583c75: Add opt-in job status tracking to AsyncJob

  Pass `trackStatus: true` and AsyncJob records each job's lifecycle, which you can read with two new methods:

  - `getStatus(jobId)` returns the job's current state plus every state it has passed through.
  - `waitUntilComplete(jobId, options?)` waits until the job reaches `complete` or `failed`, with `timeoutMs`, `pollIntervalMs`, and `AbortSignal` support.

  Transitions are appended rather than overwritten, so intermediate states stay observable no matter when you read them. A handler that finishes in a millisecond still records that it went through `processing`, and a caller that checks once after the job settled sees the whole sequence. That removes the need to pad a handler with an artificial delay just to make the `processing` state catchable, and a retry appends another `processing` entry so attempt counts are visible too.

  Appends are guarded by a compare-and-swap, so the two ways two writers can hold the same record at once cannot drop a transition: a `queued` write arriving after SQS already delivered the message, and a duplicate delivery of the same message on an at-least-once queue.

  When the handler gets there first it creates the record itself, dating the submission from the moment it first saw the job, since that is all it knows. The `queued` write that arrives afterwards replaces that placeholder with the real submission time instead of dropping it, so `submittedAt` and the first transition always report when the job was submitted rather than when it started being processed.

  Enabling the flag provisions one DynamoDB table for the job's status records, with a 24 hour TTL, and adds a write on submit plus one per state change. Leave it off and nothing is provisioned; `submit()` stays a single SQS call and the status methods throw `StatusNotTracked`.

  Status writes on the handler path are logged rather than thrown, so bookkeeping can never retry work that succeeded or mask work that failed. The trade is that a dropped terminal write leaves a finished job without a terminal state, so read `waitUntilComplete()`'s `Timeout` as "status unknown" rather than "still running".

- Updated dependencies [5b2aede]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/bb-distributed-table@0.1.4
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

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
