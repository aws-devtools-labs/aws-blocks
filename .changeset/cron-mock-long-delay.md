---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/blocks": patch
---

Prevent long local CronJob rate schedules from firing immediately when their interval exceeds Node's timer limit. Split long rate intervals into bounded, unreferenced timeouts, keep recurring deadlines on their original schedule, and skip missed periods after a long pause.
