# AsyncJob — Design

Design document for AsyncJob. For usage, examples, and best practices, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-async-job`
**Type:** Primitive (new infrastructure)
**AWS Services:** Amazon SQS + shared Lambda

## Overview

AsyncJob provides background job processing: submit a payload, get a job ID back, and a handler processes it asynchronously with automatic retries and dead-letter handling. It targets fire-and-forget work offloaded from the request path — sending emails, processing uploads, generating reports, fan-out tasks.

**Key distinction from CronJob:** AsyncJob is the programmable runtime primitive — it exposes `submit()` and `submitBatch()`, and work is triggered when application code enqueues a payload. CronJob is a pure infrastructure declaration with no runtime methods, triggered by an EventBridge schedule. Both target the shared Lambda.

## Architecture

```
Application code
    └── submit(payload) / submitBatch(payloads)
         └── SQS queue (one per AsyncJob instance)
              └── SqsEventSource → shared Lambda
                   └── routes record by queue name → registered handler
                        └── handler(payload, context)

Status (only when trackStatus: true)
    └── nested DistributedTable (partition key jobId, TTL expiresAt)
         └── queued on submit, processing per delivery, complete/failed on settle
              └── getStatus(jobId) / waitUntilComplete(jobId)

Retry / failure
    └── SQS redrive: maxReceiveCount = maxRetries → dead-letter queue (DLQ)

Local Mock
    └── AsyncJob class (extends Scope)
         └── in-process queue (setTimeout) with retry + DLQ bookkeeping
              └── _queue: { pending, processing, delayed, failed, totals }
```

## Design Decisions

### D-AJ-1: SQS standard queue with a dedicated DLQ

**Decision:** Each AsyncJob creates its own SQS standard queue plus a dedicated dead-letter queue. The main queue's redrive policy sets `maxReceiveCount` to `maxRetries` (default 3); exhausted messages move to the DLQ (14-day retention).

**Rationale:** A per-job DLQ isolates poison messages so a single failing job type can't bury unrelated work. Standard (not FIFO) queues give nearly unlimited throughput and at-least-once delivery, which matches the idempotent-handler contract. The 14-day DLQ retention is the SQS maximum, giving operators time to inspect and redrive failures.

### D-AJ-2: Shared Lambda target (not a dedicated per-job Lambda)

**Decision:** The queue's `SqsEventSource` targets the shared API Lambda — the same function used by API handlers and CronJob — rather than a dedicated function per job.

**Rationale:** One Lambda handles all routes, async jobs, and cron jobs, so handlers can compose other Building Blocks (KVStore, FileBucket, etc.) with permissions already granted, and there are no per-job cold starts or idle cost. The trade-off is shared timeout (900 s) and memory across all job types.

### D-AJ-3: Visibility timeout pinned to the Lambda timeout

**Decision:** The main queue's visibility timeout is set to 900 seconds — equal to the shared Lambda's maximum timeout.

**Rationale:** SQS requires the visibility timeout to be at least as long as the consumer's processing time; otherwise a still-running message becomes visible again and is processed twice. Pinning it to the Lambda's 900 s ceiling guarantees a message is never redelivered while its handler is still running.

### D-AJ-4: Client-side validation before enqueue

**Decision:** `submit()`/`submitBatch()` validate the schema (when configured) and the 256 KB payload size before calling SQS. Batch size (1–10) and emptiness are validated first.

**Rationale:** Failing fast on the caller's side produces a precise typed error (`PayloadTooLarge`, `ValidationFailed`, `BatchEmpty`, `BatchTooLarge`) instead of a generic SQS rejection, and avoids a network round-trip for input that cannot succeed. The mock applies identical checks so violations surface the same `error.name` in local dev.

### D-AJ-5: Event routing via queue name

**Decision:** In AWS, the handler is registered with `registerLambdaEventHandler(EventSourceMapping.SQS, queueName, ...)`. The shared Lambda routes an incoming SQS record to the matching AsyncJob by the queue name parsed from the queue URL. The queue URL is injected via the `BLOCKS_QUEUE_URL_{FULLID}` environment variable.

**Rationale:** Routing by queue name keeps dispatch consistent with the rest of the framework (CronJob routes by `source` + `jobName`) and needs no extra infrastructure. When the env var is absent (e.g. during codegen, not a real Lambda invocation), handler registration is skipped so synthesis does not fail.

### D-AJ-6: Browser stub is a no-op

**Decision:** The `index.browser.ts` entry point exports an `AsyncJob` whose constructor does nothing, re-exports the shared `AsyncJobErrors` map, and re-exports the package's types.

**Rationale:** AsyncJob enqueues to SQS (AWS runtime) or runs an in-process queue (mock, Node). Neither is available in the browser. A no-op stub keeps the package importable in isomorphic bundles without pulling in the AWS SDK; job submission only happens server-side (server actions, API routes, Lambda handlers). Types and error constants are erased or inert, so re-exporting them costs nothing at runtime and lets isomorphic code type against `AsyncJobStatus` without importing the server entry point.

### D-AJ-7: Job status is an append-only transition history, opt-in per job

**Decision:** `trackStatus: true` provisions a nested `DistributedTable` (partition key `jobId`, TTL attribute `expiresAt`, 24-hour retention) and records a job's lifecycle into it: `queued` on submit, `processing` at the start of every delivery, and `complete` or `failed` once it settles. Transitions are **appended** to a `transitions` array rather than overwriting a single state field. Two runtime methods read it: `getStatus(jobId)` and `waitUntilComplete(jobId, options?)`. Without the flag nothing is provisioned and both methods throw `StatusNotTrackedException`.

**Rationale:** The state a caller most wants to see is `processing`, and it is the one hardest to catch — a handler that finishes in a millisecond passes through it faster than any client can poll. Storing the current state alone therefore makes observation a race, which callers were previously forced to win by padding their handler with an artificial delay. An append-only history removes the race outright: a reader that polls once, after the job settled, still sees that it passed through `processing`, so no timing assumption is needed anywhere. A retry appends another `processing` entry instead of a second terminal state, which also makes attempt counts legible.

Read-modify-write on the array is safe because SQS keeps a message invisible while its handler runs, so only one attempt writes a given job's record at a time.

Tracking is opt-in because it is not free: it adds a DynamoDB table per job plus a write on submit and one per transition, and `submitBatch` would turn a single native SQS batch into an extra batch write. AsyncJob's default remains a single SQS call, and existing deployments gain no resources until they ask for them. `DistributedTable` rather than `KVStore` because only the former supports TTL, so status records expire on their own instead of accumulating.

**Failure handling:** the `queued` write propagates to the caller — `submit()` asked for tracking, so failing loudly before the job is observable is correct. Writes on the handler path are swallowed and logged instead: throwing before the handler would retry work that was fine, and throwing after it succeeded would re-run work that had already completed. Status bookkeeping must never decide a job's fate. The visible consequence is that a dropped terminal write leaves a finished job without a terminal state, so `waitUntilComplete()` reports `Timeout` for work that actually succeeded — callers are told to read `Timeout` as "status unknown" rather than "still running", and to consult the job's own effect when they need certainty.

**Not chosen:** publishing transitions over `bb-realtime`. Push delivery does not solve the underlying problem — a subscriber that connects after the fact still misses the event — and it would add a WebSocket dependency to every AsyncJob. Recorded history is both smaller and strictly more useful, since it works for late readers, retries, and tests alike.

### D-AJ-8: Status writes use optimistic concurrency, not bare last-write-wins

**Decision:** Appending a transition is a read-modify-write, guarded by a compare-and-swap on a `version` counter: the follow-up `put` is conditional on `ifFieldEquals: { version }` (or `ifNotExists` when creating), and a lost swap re-reads and re-applies, up to 5 attempts. `recordQueued` is likewise conditional on `ifNotExists`, and treats a lost race as success. Both `version` and the TTL attribute `expiresAt` are stripped from the record `getStatus()` returns.

**Rationale:** two writers can hold the same job's record at once, in two distinct ways.

The likely one is submit versus delivery. In AWS the job id *is* the SQS message id, so the `queued` write cannot happen until `SendMessage` has returned — by which point SQS may already have delivered the message and the handler may already have created the record by backfilling `queued`. An unconditional `queued` write would then overwrite the `processing` entry and reset the state, stranding a running job at `queued` permanently.

The rarer one is duplicate delivery. Standard queues are at-least-once, and this block's own README already instructs handlers to expect more than one delivery, so two invocations can append concurrently. `batchSize` is *not* a factor: a batch carries distinct messages, hence distinct message ids and distinct partition keys, and SQS never returns the same message twice in one receive.

Neither case can corrupt an item — DynamoDB `PutItem` is atomic per item — but plain last-write-wins would silently drop a transition, and dropping the terminal one converts a successful job into a `waitUntilComplete()` timeout. A version check is far cheaper than the alternative of modelling each transition as its own row with a sort key, which would double the read cost of `getStatus()` for a history that is only ever a handful of entries.

`recordQueuedBatch` issues individual conditional writes in parallel rather than one `putBatch`, because DynamoDB's `BatchWriteItem` cannot carry a condition expression and would reintroduce the clobber. A batch is at most 10 items.

## Infrastructure (CDK)

Creates the following resources per AsyncJob instance:

1. **SQS Dead-Letter Queue** — name `{fullId}-dlq` (truncated to 80 chars), 14-day retention, `SQS_MANAGED` encryption, `enforceSSL`.
2. **SQS Main Queue** — name `{fullId}` (truncated to 80 chars), visibility timeout 900 s, redrive to the DLQ with `maxReceiveCount = maxRetries`, `SQS_MANAGED` encryption, `enforceSSL`.
3. **Event Source Mapping** — `SqsEventSource(queue, { batchSize, reportBatchItemFailures: true, maxBatchingWindow })` wired to the shared handler. `batchSize` comes from `options.batchSize` (default 10) and `maxBatchingWindow` from `options.maxBatchingWindowSeconds` (default 5 s, range 0–300). Partial-batch reporting is **always on and not configurable**, because it is required for any `batchSize > 1`. Without `ReportBatchItemFailures` in the mapping's `FunctionResponseTypes`, a single failing record makes SQS treat the entire batch as handled and delete every message in it — silent data loss. The runtime handler always returns `{ batchItemFailures }` to match. Both options are range-checked in the constructor and rejected at synth time with `InvalidOptionException`: `batchSize` must be 1–10 with no batching window, or 1–10000 once `maxBatchingWindowSeconds > 0`. Those are the limits AWS itself enforces when it creates the mapping, so the check only moves the failure from mid-deployment to synth.
4. **Status table** (only when `trackStatus: true`) — a nested `DistributedTable` at child id `status`, partition key `jobId`, TTL attribute `expiresAt`. Provisioned with the same child id and options as the runtime entry points so the table the runtime resolves is the one CDK created.

**IAM grants to handler:** `grantSendMessages` on the main queue (so handlers can enqueue further work).
**Environment variables injected:** `BLOCKS_QUEUE_URL_{FULLID}` (uppercased `fullId`, non-alphanumerics replaced with `_`) → the main queue URL, registered via `registerConfig`.

No `fromExisting()` — wrapping a pre-existing SQS queue is not supported. AsyncJob owns the queue lifecycle.

## AWS Runtime

- Reads the queue URL from `BLOCKS_QUEUE_URL_{FULLID}`; registers the SQS handler only when the URL is present.
- `submit()` sends a single `SendMessageCommand`; returns `{ jobId: MessageId }`.
- `submitBatch()` sends a `SendMessageBatchCommand` (max 10 entries). Successful entries map back to `jobIds` by index; failed entries populate `failed`. If any entry fails, it throws `BatchSubmitFailedException` carrying `failed` and `jobIds` for partial-result handling.
- Each delivered record is parsed into `{ payload, context }` where `context = { jobId: messageId, receiveCount: ApproximateReceiveCount, sentAt: SentTimestamp }`.
- SQS redrive handles retries; after `maxReceiveCount` deliveries the message lands in the DLQ.
- When `trackStatus` is enabled, `submit()` records `queued` after the send (the job id *is* the SQS message id, so it is not known before), `submitBatch()` records the whole batch with one `putBatch`, and `_processRecord` records `processing` before the handler and `complete` after it. A handler error only records `failed` once `receiveCount` has reached `maxRetries` — SQS owns the retry decision, so earlier failures record nothing and the next delivery simply appends another `processing` entry.

## Mock Implementation

- An in-process queue drives processing via `setTimeout(…, 0)`; `delaySeconds` is honored with a deferred timer.
- Job IDs are a 13-character slice of `randomUUID()`.
- Retry semantics mirror AWS: on handler error the entry is retried until `receiveCount >= maxRetries`, then moved to an in-memory `failed` (DLQ) list with `failedAt` and `lastError` recorded.
- Queue state is exposed on `_queue` (`pending`, `processing`, `delayed`, `failed`, `totalSubmitted`, `totalCompleted`) for dev-server inspection.
- Identical schema and 256 KB payload-size validation runs before enqueue, producing the same typed errors as AWS.
- When `trackStatus` is enabled, the same `JobStatusTracker` runs as in AWS — it composes a `DistributedTable`, whose own conditional exports resolve to the mock (JSON on disk under `.bb-data/`) locally and to DynamoDB in AWS, so there is one status code path rather than two. `submit()` records `queued` before scheduling the entry, and `processEntry` records `processing` per attempt and `complete`/`failed` on settle.
- Console logs trace submission, completion (with duration), retries, and DLQ moves, prefixed `[AsyncJob:{id}]`.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| In-process queue (not SQS) | Jobs run in the dev server process; nothing persists across restarts | No mitigation — local queue is for development flow. Sandbox testing exercises real SQS |
| Handler runs in-process (not isolated) | Shared memory, no cold start, no per-job timeout enforcement | No mitigation — the shared Lambda in AWS is also not isolated per-job |
| No real visibility timeout | Retries are immediate rather than after a timeout window | No mitigation — timing differences don't affect at-least-once + retry correctness |
| `submitBatch()` never returns partial failures | The mock enqueues each payload locally, so `failed` is always empty and `BatchSubmitFailed` is never thrown | AWS surfaces per-entry failures; design handlers and callers to handle the `failed` array and `BatchSubmitFailedException` |
| Status records never expire locally | The mock `DistributedTable` has no TTL sweeper, so status records persist in `.bb-data/` until it is cleared, whereas DynamoDB deletes them ~24 hours after the last transition | No mitigation needed — local records are small and `.bb-data/` is disposable. Do not rely on a record being *absent* after 24 hours in either runtime; DynamoDB TTL deletion is asynchronous and best-effort |
| Concurrent status writes never actually collide locally | The mock queue delivers each job once to a single in-process consumer, so the compare-and-swap in D-AJ-8 never has to retry and a dropped terminal write cannot happen. In AWS at-least-once delivery makes both reachable | The CAS is exercised directly against the tracker in unit tests rather than through the mock queue. Callers must read `waitUntilComplete()`'s `Timeout` as "status unknown" rather than "still running", since only the deployed runtime can drop a terminal write |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation — IAM is handled by CDK grants automatically |

## Integration with CronJob

AsyncJob and CronJob are complementary primitives:

| Aspect | AsyncJob | CronJob |
|--------|----------|---------|
| **Trigger** | Event-based (code calls `.submit()`) | Time-based (EventBridge schedule) |
| **Runtime methods** | `.submit()`, `.submitBatch()`, `.getStatus()`, `.waitUntilComplete()` | None (infrastructure-only) |
| **AWS service** | SQS | EventBridge Scheduler |
| **Delivery guarantee** | At-least-once (SQS) | At-least-once (EventBridge) |
| **Retry mechanism** | SQS redrive + DLQ | Lambda async invoke retry |
| **Payload** | Dynamic per `.submit()` call | Static `input` set at deploy time |
| **Lambda target** | Shared Lambda (same as CronJob) | Shared Lambda (same as AsyncJob) |

Common pattern: a CronJob triggers periodic work that uses an AsyncJob for fan-out:

```typescript
const processor = new AsyncJob<{ itemId: string }>(scope, 'processor', {
  handler: async (payload) => { /* process one item */ },
});

new CronJob(scope, 'daily-batch', {
  schedule: 'cron(0 2 * * ? *)',
  handler: async () => {
    const items = await db.query({ stale: true });
    await processor.submitBatch(items.map((i) => ({ itemId: i.id })));
  },
});
```
