---
"@aws-blocks/bb-async-job": minor
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": minor
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

This is a `minor` bump, not a patch: every consumer that never set `batchSize`
inherits batched invocations and up to 5s of added delivery latency without
opting in, so it should not arrive through a patch-range update. The umbrella
`@aws-blocks/blocks` gets the same bump because it re-exports `AsyncJob` and
`AsyncJobOptions`.

The main queue's visibility timeout is now `900 + maxBatchingWindowSeconds`
seconds instead of a flat `900`. A message becomes invisible when the poller
receives it, before the batching window elapses and before the handler runs, so
a flat 900s let SQS redeliver a message whose invocation was still running.

`bb-agent` opts out of the new defaults with `batchSize: 1` and
`maxBatchingWindowSeconds: 0`. It submits an internal job per interactive agent
turn (plus a second on HITL resume) and the caller is blocked on that job
starting, so a batching window would add up to 5s of latency to a human-facing
path; `batchSize: 1` also keeps one failing turn from sharing a batch with
others, which matters because the handler is not idempotent. Both the runtime
and CDK construction sites set the same options so they synthesize an identical
event source mapping.
