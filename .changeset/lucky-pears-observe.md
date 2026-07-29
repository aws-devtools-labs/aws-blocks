---
"@aws-blocks/bb-async-job": minor
"@aws-blocks/blocks": patch
---

Add opt-in job status tracking to AsyncJob

Pass `trackStatus: true` and AsyncJob records each job's lifecycle, which you can read with two new methods:

- `getStatus(jobId)` returns the job's current state plus every state it has passed through.
- `waitUntilComplete(jobId, options?)` waits until the job reaches `complete` or `failed`, with `timeoutMs`, `pollIntervalMs`, and `AbortSignal` support.

Transitions are appended rather than overwritten, so intermediate states stay observable no matter when you read them. A handler that finishes in a millisecond still records that it went through `processing`, and a caller that checks once after the job settled sees the whole sequence. That removes the need to pad a handler with an artificial delay just to make the `processing` state catchable, and a retry appends another `processing` entry so attempt counts are visible too.

Enabling the flag provisions one DynamoDB table for the job's status records, with a 24 hour TTL, and adds a write on submit plus one per state change. Leave it off and nothing is provisioned; `submit()` stays a single SQS call and the status methods throw `StatusNotTracked`.
