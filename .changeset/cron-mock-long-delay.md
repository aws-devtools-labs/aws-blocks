---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/blocks": patch
---

Prevent long local CronJob schedules from firing immediately when their timer delay exceeds Node's limit. Split long cron waits and rate intervals into bounded, unreferenced timers that only invoke the handler once the scheduled time is reached.
