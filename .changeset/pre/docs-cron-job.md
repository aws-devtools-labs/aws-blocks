---
"@aws-cdk-blocks/bb-cron-job": patch
---

docs: a job with `enabled: false` is deployed in the `DISABLED` state and cannot be triggered by hand. `InvalidSchedule` and `InvalidTimezone` are thrown at construction locally and at synth on deploy. The local mock does not retry a failed handler and ignores the year field of a cron expression.
