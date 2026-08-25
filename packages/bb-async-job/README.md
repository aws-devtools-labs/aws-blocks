# @aws-blocks/bb-async-job

Background job processing backed by SQS and Lambda.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Reference

**Common Operations → Methods**

| What you want | Use this method |
|---------------|----------------|
| Submit a job | `submit(payload)` |
| Submit with delay | `submit(payload, { delaySeconds: 60 })` |
| Submit multiple jobs | `submitBatch(payloads)` |
| Get job ID back | `const { jobId } = await job.submit(payload)` |
| Read a job's state | `getStatus(jobId)` (needs `trackStatus: true`) |
| Wait for a job to finish | `waitUntilComplete(jobId)` (needs `trackStatus: true`) |

**Keywords:** queue, job, background, async, worker, submit, batch, retry, status, transitions, SQS

**Available Methods:**
- **`submit(payload, options?)`** - Enqueue a single job (returns `{ jobId }`)
- **`submitBatch(payloads, options?)`** - Enqueue any number of jobs in one call — batches larger than SQS's 10-entry / 256 KB per-request limits are split across multiple `SendMessageBatch` requests automatically (returns `{ jobIds, failed: [] }` on full success). Because a multi-chunk submit is not atomic, on partial failure it **throws** `AsyncJobErrors.BatchSubmitFailed` — the error has `.jobIds` (real MessageIds for the entries that made it onto the queue, `null` at failed indexes) and `.failed[]` (each entry's `index`, `code`, `message`). The mock runtime never partially fails; this is AWS-only.
- **`getStatus(jobId)`** - Read a job's recorded state and full transition history (returns `AsyncJobStatus | null`). Requires `trackStatus: true`.
- **`waitUntilComplete(jobId, options?)`** - Wait until the job reaches `complete` or `failed` (returns the final `AsyncJobStatus`). Requires `trackStatus: true`.

## Quick Start

```typescript
import { Scope } from '@aws-blocks/core';
import { AsyncJob } from '@aws-blocks/bb-async-job';

const scope = new Scope('my-app');

const emailJob = new AsyncJob(scope, 'welcome-email', {
  handler: async (payload: { to: string; subject: string }, ctx) => {
    console.log(`Processing job ${ctx.jobId}, attempt ${ctx.receiveCount}`);
    await sendEmail(payload.to, payload.subject);
  },
});

// Submit from your API — returns immediately
const { jobId } = await emailJob.submit({ to: 'alice@example.com', subject: 'Welcome' });
```

## When to Use

- Sending emails or notifications
- Processing file uploads
- Generating reports
- Any fire-and-forget task that shouldn't block the API response

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `handler` | (required) | Async function that processes each job |
| `schema` | — | StandardSchemaV1 (Zod, Valibot, etc.) for payload validation on submit |
| `maxRetries` | 3 | Maximum attempts before sending to the dead-letter queue |
| `batchSize` | 10 | Messages per Lambda invocation |
| `maxBatchingWindowSeconds` | 5 | Seconds SQS waits to fill a batch before invoking the Lambda |
| `trackStatus` | `false` | Record every job's state transitions so `getStatus()` / `waitUntilComplete()` can read them |
| `logger` | — | Optional logger for internal operations; defaults to a Logger at error level |

### Batching and handler requirements

The queue is a standard SQS queue, so delivery is at-least-once and a handler must
already be idempotent to be correct — a message can be delivered more than once
regardless of `batchSize`. Batching widens the window in which that happens: with
`batchSize: 10`, a Lambda that times out or runs out of memory partway through a
batch redelivers all ten messages, including the ones whose handler had already
finished. Per-record failures on their own are isolated (only the failed message is
redelivered), so this is specifically the whole-invocation failure case.

Set `batchSize: 1` for handlers that cannot tolerate being re-run, or for
latency-sensitive work — a batching window makes SQS wait up to
`maxBatchingWindowSeconds` before invoking the Lambda at all, so a job submitted on
a user-facing path starts up to that many seconds late. `maxBatchingWindowSeconds: 0`
opts out of the wait while keeping batching.

The queue's visibility timeout is set to the shared Lambda's timeout plus
`maxBatchingWindowSeconds`, because a message's visibility clock starts when the
poller receives it — before the batching window elapses and before the handler runs.

## Handler Context

The handler receives a second argument, `ctx: AsyncJobContext`, carrying metadata about the current job:

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | `string` | Unique identifier for this job (SQS message ID in AWS, truncated UUID in the mock). |
| `receiveCount` | `number` | Number of times this message has been received (`1` on first delivery; increments on each retry). |
| `sentAt` | `string` | ISO 8601 timestamp of when the message was sent (enqueued). |

In AWS, `receiveCount` is the SQS `ApproximateReceiveCount` attribute, and the name is SQS's own warning: it is a best-effort counter, not an exact one. A delivery SQS records but never hands to a handler, or a redrive that re-counts, moves it without a matching attempt. Read it as roughly how many times the job has been tried. The `attempt` on each status transition and the `attempts` total both carry this same number, so the caveat travels with them. In local dev the queue is in-process and the count is exact, so a test that asserts on an exact attempt number can pass locally and still be wrong in AWS.

## Error Constants

```typescript
import { AsyncJobErrors } from '@aws-blocks/bb-async-job';

AsyncJobErrors.PayloadTooLarge    // payload > 256 KB
AsyncJobErrors.BatchEmpty         // submitBatch([]) called with no items
AsyncJobErrors.ValidationFailed   // schema validation failed
AsyncJobErrors.BatchSubmitFailed  // one or more messages failed to enqueue
AsyncJobErrors.Timeout            // waitUntilComplete() gave up before the job settled
AsyncJobErrors.StatusNotTracked   // status method called without trackStatus: true
```

## Local Development

In local dev mode, AsyncJob uses an in-process queue. Jobs process via `setTimeout` in the same Node.js process. Retries, DLQ behavior, and payload limits are enforced identically to AWS.

## AWS Deployment

Automatically provisions an SQS queue, dead-letter queue, and connects to the shared API Lambda. Failed jobs become visible for retry after 900 seconds (matching the Lambda timeout).

## How Do I Know My Job Ran?

`submit()` is fire-and-forget — it returns as soon as the payload is queued, and the handler runs later in a separate Lambda invocation. Pass `trackStatus: true` and AsyncJob records the job's state for you:

```typescript
const job = new AsyncJob(scope, 'ingest', {
  trackStatus: true,
  handler: async (payload: { documentId: string }) => {
    await ingest(payload.documentId);
  },
});

const { jobId } = await job.submit({ documentId: 'doc-1' });

// Poll from a client, or await it server-side
const status = await job.waitUntilComplete(jobId);
status.state;                              // 'complete'
status.transitions.map((t) => t.state);    // ['queued', 'processing', 'complete']
```

### Every state stays observable

`transitions` is append-only, so reading it is not a race. A handler that finishes in a millisecond still records that it passed through `processing`, and a caller that reads the status once — long after the job settled — sees the whole sequence. You never need to slow a handler down to make an intermediate state visible.

A retry appends another `processing` entry rather than a second terminal state, so the history shows how many attempts it took:

```typescript
const status = await job.getStatus(jobId);
status.transitions.map((t) => `${t.state}#${t.attempt}`);
// ['queued#0', 'processing#1', 'processing#2', 'failed#2']
status.attempts;  // 2
status.error;     // message from the last handler error
```

### Status shape

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | `string` | Job identifier returned by `submit()`. |
| `state` | `'queued' \| 'processing' \| 'complete' \| 'failed'` | Most recent state. |
| `transitions` | `AsyncJobTransition[]` | Every state entered, in order. Each entry has `state`, `at` (ISO 8601), and `attempt`. |
| `attempts` | `number` | Times the job has been delivered to the handler. |
| `submittedAt` | `string` | ISO 8601 timestamp of submission. |
| `updatedAt` | `string` | ISO 8601 timestamp of the most recent transition. |
| `error` | `string \| undefined` | Message from the last handler error. Set when `state` is `failed`. |

`getStatus()` returns `null` for a job id it has never seen. `waitUntilComplete()` resolves on **either** terminal state — check `state` to tell success from failure — and accepts `timeoutMs` (default `30000`), `pollIntervalMs` (default `250`, with ±20% jitter), and a `signal` (`AbortSignal`) that cancels the wait and rejects with the signal's abort reason.

### Reading a Timeout

`waitUntilComplete()` throws `AsyncJobErrors.Timeout` when the job has not reached a terminal state in time. Treat that as **status unknown**, not as a verdict on the job.

Almost always it means the job is still running, so waiting again is the right move and is safe. But status writes on the handler path are best-effort by design (see below), so there is a second, rarer reading: if the write that would have recorded `complete` or `failed` was itself dropped, the job has already finished and its record will never reach a terminal state, so waiting longer will never resolve. A `Timeout` therefore does not prove the job is still in flight, and it certainly does not mean the job failed. A third reading, below, is that the delivery was killed outright.

If you need a definitive answer, check the job's own effect rather than its status — the row it writes, the file it uploads, the message it sends. That is authoritative in a way bookkeeping cannot be. `status.updatedAt` is also a useful signal: a timestamp that stops advancing well past your handler's expected duration points at a dropped write rather than slow work.

### Known limitation: a killed delivery records no failure

The `failed` transition is written from the handler's `catch`, so it exists only for errors the handler actually throws. A delivery that dies without unwinding — Lambda timeout, an out-of-memory kill, a hard crash — never reaches that `catch`, and nothing writes a terminal state on its behalf.

The record therefore stays at its last transition, normally `processing`, and stays there for good. `waitUntilComplete()` keeps polling until it gives up with `AsyncJobErrors.Timeout`, so a job that is definitively dead reads as status unknown rather than as a failure. The work itself is not lost track of: SQS redelivers on its own schedule and the message still reaches the dead-letter queue once it has burned through `maxRetries`. It is only the status record that stops telling you anything.

AsyncJob does not detect this for you yet. Until it does, a `Timeout` on a job whose `updatedAt` stopped advancing is the signal to look outside the status record: the dead-letter queue, and the handler's own CloudWatch logs for a `Task timed out` or out-of-memory line. A handler that runs close to its limit can also catch the condition itself — check the remaining wall clock and throw before the Lambda deadline, so the `catch` does run and `failed` is recorded.

### Cost of enabling it

`trackStatus: true` provisions one DynamoDB table (on-demand billing) for the job's status records and adds a write on submit plus one per state change. Records expire 24 hours after their last transition. Leave the flag off for pure fire-and-forget work — nothing is provisioned and `submit()` stays a single SQS call. Calling `getStatus()` or `waitUntilComplete()` without the flag throws `AsyncJobErrors.StatusNotTracked`.

Status writes on the handler path never fail a job: if one errors it is logged and the job's own outcome is unaffected, so a bookkeeping blip can neither retry work that succeeded nor mask work that failed. That is a deliberate trade — the job's correctness outranks its record — and it is what makes the `Timeout` caveat above possible. Appends themselves are guarded by a compare-and-swap, so two overlapping deliveries of the same job cannot silently drop each other's transitions.

### Other options

**Use `ctx.jobId` for logging:**
```typescript
handler: async (payload, ctx) => {
  console.log(`[${ctx.jobId}] Starting work...`);
  // Your logs will include the job ID for tracing
}
```

**Check the dead-letter queue:** Jobs that fail after `maxRetries` attempts land in the DLQ. In AWS, check the `{scope}-{id}-dlq` queue in the SQS console. In local dev, failed jobs are logged to the console with their full payload.


