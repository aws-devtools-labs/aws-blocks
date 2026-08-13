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

Both options are now range-checked in the `AsyncJob` constructor, so an
out-of-range value fails fast at synth time with `InvalidOptionException` naming
the option instead of surfacing as an opaque CloudFormation error mid-deploy:
`batchSize` must be 1–10 without a batching window (1–10000 with one), and
`maxBatchingWindowSeconds` must be 0–300.

Retry semantics are unchanged. SQS tracks `ApproximateReceiveCount` per message
and partial batch responses redeliver only failed records, so `maxRetries` still
means "attempts for this message" and the DLQ `maxReceiveCount` keeps its
meaning at any batch size.

The umbrella `@aws-blocks/blocks` gets a patch bump because it re-exports
`AsyncJob` and `AsyncJobOptions`.
