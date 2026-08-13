---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/blocks": patch
---

feat(bb-async-job): batch SQS messages by default, with a configurable batching window and partial batch failure reporting

`AsyncJob` triggered its Lambda with `batchSize: 1`, so every queued job cost a
full invocation. The default is now `batchSize: 10` with
`maxBatchingWindowSeconds: 5`, and two new options on `AsyncJobOptions` expose
that behavior: `maxBatchingWindowSeconds` (0–300) trades latency for fuller
batches, and `reportBatchItemFailures` (default `true`) enables SQS partial
batch responses so only the failed records are redelivered.

`reportBatchItemFailures` cannot be disabled while `batchSize > 1`: without
partial batch responses SQS deletes every message in a batch as soon as the
invocation returns, so a single failing record silently discards the rest. That
combination is rejected at synth time with an error pointing at `batchSize: 1`
for genuinely all-or-nothing batches.

Retry semantics are unchanged. SQS tracks `ApproximateReceiveCount` per message
and partial batch responses redeliver only failed records, so `maxRetries` still
means "attempts for this message" and the DLQ `maxReceiveCount` keeps its
meaning at any batch size.

The umbrella `@aws-blocks/blocks` gets a patch bump because it re-exports
`AsyncJob` and `AsyncJobOptions`.
