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

**Decision:** The `index.browser.ts` entry point exports an `AsyncJob` whose constructor does nothing and a reduced `AsyncJobErrors` map.

**Rationale:** AsyncJob enqueues to SQS (AWS runtime) or runs an in-process queue (mock, Node). Neither is available in the browser. A no-op stub keeps the package importable in isomorphic bundles without pulling in the AWS SDK; job submission only happens server-side (server actions, API routes, Lambda handlers).

## Infrastructure (CDK)

Creates the following resources per AsyncJob instance:

1. **SQS Dead-Letter Queue** — name `{fullId}-dlq` (truncated to 80 chars), 14-day retention, `SQS_MANAGED` encryption, `enforceSSL`.
2. **SQS Main Queue** — name `{fullId}` (truncated to 80 chars), visibility timeout 900 s, redrive to the DLQ with `maxReceiveCount = maxRetries`, `SQS_MANAGED` encryption, `enforceSSL`.
3. **Event Source Mapping** — `SqsEventSource(queue, { batchSize })` wired to the shared handler.

**IAM grants to handler:** `grantSendMessages` on the main queue (so handlers can enqueue further work).
**Environment variables injected:** `BLOCKS_QUEUE_URL_{FULLID}` (uppercased `fullId`, non-alphanumerics replaced with `_`) → the main queue URL, registered via `registerConfig`.

No `fromExisting()` — wrapping a pre-existing SQS queue is not supported. AsyncJob owns the queue lifecycle.

## AWS Runtime

- Reads the queue URL from `BLOCKS_QUEUE_URL_{FULLID}`; registers the SQS handler only when the URL is present.
- `submit()` sends a single `SendMessageCommand`; returns `{ jobId: MessageId }`.
- `submitBatch()` sends a `SendMessageBatchCommand` (max 10 entries). Successful entries map back to `jobIds` by index; failed entries populate `failed`. If any entry fails, it throws `BatchSubmitFailedException` carrying `failed` and `jobIds` for partial-result handling.
- Each delivered record is parsed into `{ payload, context }` where `context = { jobId: messageId, receiveCount: ApproximateReceiveCount, sentAt: SentTimestamp }`.
- SQS redrive handles retries; after `maxReceiveCount` deliveries the message lands in the DLQ.

## Mock Implementation

- An in-process queue drives processing via `setTimeout(…, 0)`; `delaySeconds` is honored with a deferred timer.
- Job IDs are a 13-character slice of `randomUUID()`.
- Retry semantics mirror AWS: on handler error the entry is retried until `receiveCount >= maxRetries`, then moved to an in-memory `failed` (DLQ) list with `failedAt` and `lastError` recorded.
- Queue state is exposed on `_queue` (`pending`, `processing`, `delayed`, `failed`, `totalSubmitted`, `totalCompleted`) for dev-server inspection.
- Identical schema and 256 KB payload-size validation runs before enqueue, producing the same typed errors as AWS.
- Console logs trace submission, completion (with duration), retries, and DLQ moves, prefixed `[AsyncJob:{id}]`.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| In-process queue (not SQS) | Jobs run in the dev server process; nothing persists across restarts | No mitigation — local queue is for development flow. Sandbox testing exercises real SQS |
| Handler runs in-process (not isolated) | Shared memory, no cold start, no per-job timeout enforcement | No mitigation — the shared Lambda in AWS is also not isolated per-job |
| No real visibility timeout | Retries are immediate rather than after a timeout window | No mitigation — timing differences don't affect at-least-once + retry correctness |
| `submitBatch()` never returns partial failures | The mock enqueues each payload locally, so `failed` is always empty and `BatchSubmitFailed` is never thrown | AWS surfaces per-entry failures; design handlers and callers to handle the `failed` array and `BatchSubmitFailedException` |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation — IAM is handled by CDK grants automatically |

## Integration with CronJob

AsyncJob and CronJob are complementary primitives:

| Aspect | AsyncJob | CronJob |
|--------|----------|---------|
| **Trigger** | Event-based (code calls `.submit()`) | Time-based (EventBridge schedule) |
| **Runtime methods** | `.submit()`, `.submitBatch()` | None (infrastructure-only) |
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
