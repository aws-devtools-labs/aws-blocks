---
'@aws-blocks/core': patch
---

Production `destroy` now retries a failed teardown with backoff, emptying each
stack's versioned S3 buckets before each retry — the same resilient path the
sandbox destroy already uses. A single-shot `cdk destroy` previously surfaced a
transient teardown failure (a non-empty versioned bucket whose autoDeleteObjects
Lambda never provisioned, or an API Gateway control-plane throttle) as a hard
failure with no recovery.

Tradeoff: a destroy that fails for a non-transient reason now takes the full
backoff (60s then 120s) to surface the real error instead of failing on the
first attempt. This matches the sandbox path; `retryDelays` is injectable if a
faster failure signal is ever wanted for a specific caller.
