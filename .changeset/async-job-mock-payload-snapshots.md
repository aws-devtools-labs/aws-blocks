---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/blocks": patch
---

Make local AsyncJob deliveries use the validated JSON snapshot, matching the AWS runtime. Changes to a submitted object or a failed handler's payload no longer affect queued jobs, retries, or the retained dead-letter payload.
