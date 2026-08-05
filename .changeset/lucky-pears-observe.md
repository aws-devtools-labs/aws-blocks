---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/blocks": patch
---

Add opt-in job status tracking to AsyncJob

Pass `trackStatus: true` and AsyncJob records each job's lifecycle, which you can read with two new methods:

- `getStatus(jobId)` returns the job's current state plus every state it has passed through.
- `waitUntilComplete(jobId, options?)` waits until the job reaches `complete` or `failed`, with `timeoutMs`, `pollIntervalMs`, and `AbortSignal` support.

Transitions are appended rather than overwritten, so intermediate states stay observable no matter when you read them. A handler that finishes in a millisecond still records that it went through `processing`, and a caller that checks once after the job settled sees the whole sequence. That removes the need to pad a handler with an artificial delay just to make the `processing` state catchable, and a retry appends another `processing` entry so attempt counts are visible too.

Appends are guarded by a compare-and-swap, so the two ways two writers can hold the same record at once cannot drop a transition: a `queued` write arriving after SQS already delivered the message, and a duplicate delivery of the same message on an at-least-once queue.

When the handler gets there first it creates the record itself, dating the submission from the moment it first saw the job, since that is all it knows. The `queued` write that arrives afterwards replaces that placeholder with the real submission time instead of dropping it, so `submittedAt` and the first transition always report when the job was submitted rather than when it started being processed.

Enabling the flag provisions one DynamoDB table for the job's status records, with a 24 hour TTL, and adds a write on submit plus one per state change. Leave it off and nothing is provisioned; `submit()` stays a single SQS call and the status methods throw `StatusNotTracked`.

Status writes on the handler path are logged rather than thrown, so bookkeeping can never retry work that succeeded or mask work that failed. The trade is that a dropped terminal write leaves a finished job without a terminal state, so read `waitUntilComplete()`'s `Timeout` as "status unknown" rather than "still running".
