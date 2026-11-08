---
"@aws-blocks/core": patch
---

test(core): compute the longest a `destroy` or `sandbox:destroy` retry loop can run

The destroy retry schedules now live in their own module, which also computes the longest the retry loop can run when no single `cdk destroy` attempt takes more than a given time. A throttled destroy can run past the 20-minute throttle budget: the budget starts at the first failure, and the attempt after the last wait still runs. The telemetry end-to-end tests use this value as their destroy timeout, so a throttled destroy is no longer stopped while it is still retrying. No change to how `destroy` or `sandbox:destroy` retry.
