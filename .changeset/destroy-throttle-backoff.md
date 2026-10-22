---
'@aws-blocks/core': patch
---

`sandbox:destroy` and production `destroy` now ride out AWS API throttling
during teardown. When the stack's events show a resource delete failed on a
throttle (most often API Gateway's `DeleteRestApi` quota of one request every
30 seconds per account, hit when several stacks in one account are torn down at
once), the retry backs off exponentially with jitter (about 1, 2, 4, then 5
minute steps) for up to 20 minutes after the first failure, instead of giving
up after the fixed 60s and 120s waits. The jitter keeps parallel teardowns from
retrying in lockstep.

Failures that are not throttles keep the existing schedule (60s, then 120s).
If the stack events cannot be read, the failure is treated as not throttled.
