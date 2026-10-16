---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/blocks": patch
---

Validate delayed job submissions before queueing them, matching Amazon SQS delay constraints. Preserve the typed validation error when an API call crosses the RPC boundary.
