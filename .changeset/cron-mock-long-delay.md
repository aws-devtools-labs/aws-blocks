---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/blocks": patch
---

Prevent long local CronJob rate schedules from firing immediately when their interval exceeds Node's timer limit. Split long rate intervals into bounded, unreferenced timeouts that wait for the full interval before invoking the handler.
