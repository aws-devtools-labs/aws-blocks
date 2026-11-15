---
"@aws-blocks/bb-async-job": patch
---

Clarify in the README that `maxRetries` counts total deliveries including the first (`3` = one attempt plus two retries), matching the queue's `maxReceiveCount`.
