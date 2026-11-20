# @aws-cdk-blocks/bb-async-job

Background job processing backed by SQS, run on Lambda or a container.

**When to use:** Work that must not block the API response: sending email, processing an upload, generating a report.

**When NOT to use:** Work that runs on a schedule: use `CronJob`.

**Keywords:** queue, job, background, async, worker, submit, batch, retry, status, transitions, SQS

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

```typescript
import { Scope } from '@aws-cdk-blocks/core';
import { AsyncJob } from '@aws-cdk-blocks/bb-async-job';

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

## API

`new AsyncJob<T>(scope, id, options)`. `T` is the payload type.

| Method | Returns | Description |
|--------|---------|-------------|
| `submit(payload, { delaySeconds? })` | `Promise<{ jobId }>` | Enqueues one job and returns as soon as it is queued. `delaySeconds` (0–900, default 0) delays processing. |
| `submitBatch(payloads, { delaySeconds? })` | `Promise<{ jobIds, failed }>` | Enqueues 1 to 10,000 jobs. See [submitBatch()](#submitbatch). |
| `getStatus(jobId)` | `Promise<AsyncJobStatus \| null>` | Reads a job's recorded state and transition history. `null` for a job id it has never seen. Requires `trackStatus: true`. |
| `waitUntilComplete(jobId, { timeoutMs?, pollIntervalMs?, signal? })` | `Promise<AsyncJobStatus>` | Waits until the job reaches `complete` or `failed` and returns the final status. Requires `trackStatus: true`. See [Job status](#job-status-trackstatus). |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `handler` | `(payload: T, ctx: AsyncJobContext) => Promise<void>` | (required) | Async function that processes each job. Must be idempotent: delivery is at-least-once on every compute. |
| `schema` | `StandardSchemaV1<T>` | — | StandardSchemaV1 (Zod, Valibot, etc.) for payload validation on submit |
| `maxRetries` | `number` | 3 | Total deliveries, **including the first**, before the job goes to the dead-letter queue (the queue's `maxReceiveCount`). `3` = one attempt plus two retries; to run a job at most twice, set `maxRetries: 2` |
| `batchSize` | `number` | 10 | Lambda only. Messages per Lambda invocation. 1–10, or up to 10000 when `maxBatchingWindowSeconds` is greater than 0. See [Batching on Lambda](#batching-on-lambda). |
| `maxBatchingWindowSeconds` | `number` | 5 | Lambda only. Seconds SQS waits to fill a batch before invoking the Lambda. 0–300. |
| `trackStatus` | `boolean` | `false` | Record every job's state transitions so `getStatus()` / `waitUntilComplete()` can read them |
| `logger` | `ChildLogger` | — | Optional logger for internal operations; defaults to a Logger at error level |
| `compute` | `Compute` | the scope's compute | Inherits the nearest parent scope's compute, falling back to the backend default when none is assigned. Assign a container `Compute` explicitly for long-running work. |
| `timeoutSeconds` | `number` | — | Wall-clock limit for one delivery. On a container the runtime terminates the job's worker at the deadline; on serverless it's bounded by the function timeout. |
| `maxConcurrencyPerCPU` | `number` | 5 per job per instance when omitted | Container-only, and a compile error without an explicit container `compute`. In-flight deliveries **per vCPU**; the per-instance count is `max(1, ceil(maxConcurrencyPerCPU × vcpu))`. Higher for IO-bound work; explicitly set 1 for CPU-bound. |

## Errors

```typescript
import { AsyncJobErrors, isBlocksError } from 'aws-cdk-blocks';

try {
  await emailJob.submit(payload);
} catch (e: unknown) {
  if (isBlocksError(e, AsyncJobErrors.PayloadTooLarge)) {
    // store the data elsewhere and submit a reference to it
  }
}
```

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `AsyncJobErrors.PayloadTooLarge` | `PayloadTooLargeException` | `submit()` or `submitBatch()`: a serialized payload exceeds 256 KB. |
| `AsyncJobErrors.ValidationFailed` | `ValidationFailedException` | `submit()` or `submitBatch()`: a payload fails `schema`. |
| `AsyncJobErrors.BatchEmpty` | `BatchEmptyException` | `submitBatch([])`. |
| `AsyncJobErrors.BatchTooLarge` | `BatchTooLargeException` | `submitBatch()` with more than 10,000 payloads. |
| `AsyncJobErrors.BatchSubmitFailed` | `BatchSubmitFailedException` | `submitBatch()` on AWS: one or more messages failed to enqueue. See [submitBatch()](#submitbatch). |
| `AsyncJobErrors.Timeout` | `AsyncJobTimeoutException` | `waitUntilComplete()`: the job did not reach a terminal state within `timeoutMs`. See [Timeout means status unknown](#timeout-means-status-unknown). |
| `AsyncJobErrors.StatusNotTracked` | `StatusNotTrackedException` | `getStatus()` or `waitUntilComplete()` on a job created without `trackStatus: true`. |
| `AsyncJobErrors.InvalidOption` | `InvalidOptionException` | Synth time: `batchSize` or `maxBatchingWindowSeconds` is outside its range on a Lambda compute, or `maxConcurrencyPerCPU` is set and the compute is not a container. |
| `AsyncJobErrors.UnsupportedCompute` | `UnsupportedComputeException` | Synth time: the resolved compute is not a Lambda or container compute, or belongs to another backend. |

## submitBatch()

- Returns `{ jobIds, failed: [] }` when every payload is enqueued. `jobIds` is in the order of `payloads`.
- On AWS, `submitBatch()` is not atomic: SQS can reject individual entries even in a single request, and large batches span multiple requests. If any entry fails, `submitBatch()` throws `AsyncJobErrors.BatchSubmitFailed`; other entries may already be on the queue.
- The error has `.jobIds` (the job id of each enqueued entry, `null` at failed indexes) and `.failed[]` (each failed entry's `index`, `code`, `message`). Retry only the `null` indexes.
- A request that fails as a whole (throttling, connection) fails every entry in it, and the requests not yet started are not sent.
- The local mock never partially fails.

## Running on a container compute

Assign a container `Compute` for long-running or high-memory work:

```ts
import { Compute } from 'aws-cdk-blocks';

const worker = new Compute(scope, 'worker', {
  type: 'container',
  size: { vcpu: 1, memory: 2048 },
  scaling: { minInstances: 1, maxInstances: 10 },
});

new AsyncJob(scope, 'reports', {
  compute: worker,
  timeoutSeconds: 60 * 30,   // may run 30 minutes — enforced by the runtime
  maxConcurrencyPerCPU: 4,   // up to 4 × vCPU deliveries at once per instance
  handler: async (payload) => { /* ... */ },
});
```

- On a container each delivery runs in its own worker thread, which the runtime terminates at `timeoutSeconds`.
- A deploy that changes your code replaces the container's tasks. A delivery still running about 2 minutes later is stopped and redelivered from the start, and the redelivery counts toward `maxRetries`.
- For `size`, `scaling` and the other compute options, see [Compute](../bb-compute/README.md).

## Batching on Lambda

`batchSize` and `maxBatchingWindowSeconds` apply on a Lambda compute only.

- A handler that throws fails its own message only: the other messages of the batch are not redelivered.
- A Lambda that times out or runs out of memory partway through a batch redelivers the whole batch, including the messages whose handler had already finished.
- `maxBatchingWindowSeconds` makes SQS wait up to that many seconds before invoking the Lambda, so a job starts up to that many seconds late. `maxBatchingWindowSeconds: 0` removes the wait and keeps batching.
- Set `batchSize: 1` for latency-sensitive work, and to keep a whole-invocation failure from re-running other jobs.

## Handler context

The handler receives a second argument, `ctx: AsyncJobContext`, carrying metadata about the current job:

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | `string` | Unique identifier for this job (SQS message ID in AWS, truncated UUID in the mock). |
| `receiveCount` | `number` | Number of times this message has been received (`1` on first delivery; increments on each retry). |
| `sentAt` | `string` | ISO 8601 timestamp of when the message was sent (enqueued). |

On AWS, `receiveCount` is the SQS `ApproximateReceiveCount` attribute: approximate, not exact. The `attempt` on each status transition and the `attempts` total carry the same number. Locally the count is exact, so a test that asserts an exact attempt number can pass locally and fail on AWS.

## Job status (trackStatus)

`submit()` returns as soon as the payload is queued. With `trackStatus: true`, AsyncJob records the job's state transitions, and `getStatus()` and `waitUntilComplete()` read them:

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

`waitUntilComplete()` resolves on **either** terminal state — check `state` to tell success from failure. Its options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeoutMs` | `number` | `30000` | Total time to wait before throwing `AsyncJobErrors.Timeout`. |
| `pollIntervalMs` | `number` | `250` | Delay between status reads, with ±20% jitter. |
| `signal` | `AbortSignal` | — | Cancels the wait and rejects with the signal's abort reason. |

### Transitions

`transitions` is append-only: a read after the job settled shows every state it entered, including `processing`.

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

### Timeout means status unknown

`waitUntilComplete()` throws `AsyncJobErrors.Timeout` when the job has not reached a terminal state in time. Treat that as **status unknown**, not as a verdict on the job. The causes:

1. The job is still running. This is the usual cause, and waiting again is safe.
2. The status write that records `complete` or `failed` failed. A failed status write is logged and never fails or retries the job, so the job has finished and its record never reaches a terminal state.
3. The delivery was killed: a Lambda timeout, an out-of-memory kill, a hard crash. `failed` is recorded only for errors the handler throws, and AsyncJob does not detect a killed delivery, so the record stays at its last transition, normally `processing`. SQS still redelivers the message and moves it to the dead-letter queue after `maxRetries` deliveries.

To tell them apart:

- Check the job's own effect: the row it writes, the file it uploads, the message it sends.
- A `status.updatedAt` that stopped advancing well past the handler's expected duration means cause 2 or 3. Check the dead-letter queue, and the handler's CloudWatch logs for a `Task timed out` or out-of-memory line.
- Throwing before the Lambda deadline lets AsyncJob handle the error. Earlier deliveries are retried; only a throw on the final delivery records `failed`.

### Cost of trackStatus

- `trackStatus: true` provisions one DynamoDB table (on-demand billing) for the job's status records and adds a write on submit plus one per state change.
- Records expire 24 hours after their last transition.
- With the flag off nothing is provisioned and `submit()` is a single SQS call.
- Overlapping deliveries of the same job do not drop each other's transitions.

## What it provisions (AWS)

- One SQS queue named after the job's `fullId` (first 80 characters), and one dead-letter queue named with the first 76 characters of `fullId` plus `-dlq`.
- On a Lambda compute, an SQS event source on the compute's function. On a container compute, no event source: the container's runtime polls the queue.
- With `trackStatus: true`, one DynamoDB table.

A failed delivery becomes available for retry when its SQS visibility timeout expires: on a Lambda compute `900 + maxBatchingWindowSeconds` seconds after the delivery was received (905 seconds by default), on a container compute within about 2 minutes. After `maxRetries` deliveries SQS moves the message to the dead-letter queue.

## Local development

In local dev mode, AsyncJob uses an in-process queue and runs handlers in the same Node.js process. Retries, the `maxRetries` limit and payload limits are enforced as on AWS. The differences:

- A failed delivery is retried immediately.
- A job that fails `maxRetries` times is logged to the console with its full payload; there is no dead-letter queue to inspect.
- Selecting container compute does not create worker threads locally or enforce the container delivery timeout. Use a sandbox deployment to exercise those behaviors.
