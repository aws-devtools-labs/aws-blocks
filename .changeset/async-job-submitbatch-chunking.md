---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/blocks": patch
---

feat(bb-async-job): submitBatch auto-chunks batches larger than SQS limits

`submitBatch` previously rejected any batch over 10 payloads with
`BatchTooLarge`, so a caller with more than 10 jobs had to reimplement SQS's
chunking rules by hand. It now accepts any number of payloads and packs them
into `SendMessageBatch` requests bounded by both SQS per-request limits — at
most 10 entries and at most 256 KB of aggregate message body — issuing one
request per chunk. Each batch entry's `Id` is the payload's original index, so
the returned `jobIds` stay in input order and every id is the same SQS
`MessageId` that `getStatus()` / `waitUntilComplete()` look up.

A batch spanning multiple chunks is **not atomic**: an earlier chunk can land
before a later one fails. The all-or-nothing signal is unchanged — a partial
failure still throws `AsyncJobErrors.BatchSubmitFailed` — but the thrown error
now reflects the partial reality across all chunks: `.jobIds` carries the real
`MessageId` for every entry that made it onto the queue (with `null` at each
failed index) and `.failed[]` lists every failure sorted by index, so a caller
can retry only the failed indexes instead of re-submitting the whole batch.

`AsyncJobErrors.BatchTooLarge` is retained but deprecated — it is no longer
thrown. The mock runtime submits one message at a time and never partially
fails, so the not-atomic behavior is AWS-only; it now validates every payload
before enqueuing any, matching the AWS runtime.

This is a `patch` bump: pre-1.0, this repo uses `minor` to signal a breaking
change, and this is not breaking — a batch of ≤10 behaves exactly as before, no
public type changed, and the only removed behavior is a `throw` that callers
were unlikely to depend on. `@aws-blocks/blocks` gets the same bump because it
re-exports `AsyncJob`.
