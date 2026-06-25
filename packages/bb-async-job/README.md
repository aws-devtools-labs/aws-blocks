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

**Keywords:** queue, job, background, async, worker, submit, batch, retry, SQS

**Available Methods:**
- **`submit(payload, options?)`** - Enqueue a single job (returns `{ jobId }`)
- **`submitBatch(payloads, options?)`** - Enqueue up to 10 jobs in one call (returns `{ jobIds, failed: [] }` on full success). On partial failure, **throws** `AsyncJobErrors.BatchSubmitFailed` — the error has `.jobIds` (with `null` at failed indexes) and `.failed[]` (each entry's `index`, `code`, `message`). The mock runtime never partially fails; this is AWS-only.

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
| `batchSize` | 1 | Messages per Lambda invocation |
| `logger` | — | Optional logger for internal operations; defaults to a Logger at error level |

## Handler Context

The handler receives a second argument, `ctx: AsyncJobContext`, carrying metadata about the current job:

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | `string` | Unique identifier for this job (SQS message ID in AWS, truncated UUID in the mock). |
| `receiveCount` | `number` | Number of times this message has been received (`1` on first delivery; increments on each retry). |
| `sentAt` | `string` | ISO 8601 timestamp of when the message was sent (enqueued). |

## Error Constants

```typescript
import { AsyncJobErrors } from '@aws-blocks/bb-async-job';

AsyncJobErrors.PayloadTooLarge    // payload > 256 KB
AsyncJobErrors.BatchEmpty         // submitBatch([]) called with no items
AsyncJobErrors.BatchTooLarge      // batch > 10 items
AsyncJobErrors.ValidationFailed   // schema validation failed
AsyncJobErrors.BatchSubmitFailed  // one or more messages failed to enqueue
```

## Local Development

In local dev mode, AsyncJob uses an in-process queue. Jobs process via `setTimeout` in the same Node.js process. Retries, DLQ behavior, and payload limits are enforced identically to AWS.

## AWS Deployment

Automatically provisions an SQS queue, dead-letter queue, and connects to the shared API Lambda. Failed jobs become visible for retry after 900 seconds (matching the Lambda timeout).

## How Do I Know My Job Ran?

AsyncJob is fire-and-forget — `submit()` returns immediately, and the handler runs later.

**Track job status in your handler:**
```typescript
const store = new KVStore(scope, 'job-status');

const job = new AsyncJob(scope, 'process', {
  handler: async (payload, ctx) => {
    await store.put(`job:${ctx.jobId}`, 'processing');
    await doWork(payload);
    await store.put(`job:${ctx.jobId}`, 'complete');
  },
});
```

**Use `ctx.jobId` for logging:**
```typescript
handler: async (payload, ctx) => {
  console.log(`[${ctx.jobId}] Starting work...`);
  // Your logs will include the job ID for tracing
}
```

**Check the dead-letter queue:** Jobs that fail after `maxRetries` attempts land in the DLQ. In AWS, check the `{scope}-{id}-dlq` queue in the SQS console. In local dev, failed jobs are logged to the console with their full payload.


