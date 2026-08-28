---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/blocks": patch
---

feat(bb-async-job): submitBatch auto-chunks batches larger than SQS limits

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
