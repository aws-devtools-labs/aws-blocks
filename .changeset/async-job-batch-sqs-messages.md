---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/blocks": patch
---

feat(bb-async-job): batch SQS messages by default, with a configurable batching window

`AsyncJob` triggered its Lambda with `batchSize: 1`, so every queued job cost a
full invocation. The default is now `batchSize: 10` with a new
`maxBatchingWindowSeconds` option (0–300, default 5) that trades latency for
fuller batches. SQS partial batch failure reporting is always enabled, so only
the failed records of a batch are redelivered.

Retry semantics are unchanged. SQS tracks `ApproximateReceiveCount` per message
and partial batch responses redeliver only failed records, so `maxRetries` still
means "attempts for this message" and the DLQ `maxReceiveCount` keeps its
meaning at any batch size.

The umbrella `@aws-blocks/blocks` gets a patch bump because it re-exports
`AsyncJob` and `AsyncJobOptions`.
