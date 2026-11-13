---
"@aws-blocks/bb-cron-job": patch
---

In local development, a `CronJob` whose `rate(...)` is longer than about 24.8 days (for example `rate(30 days)`) no longer fires its handler every millisecond. Node clamps a timer delay above 2^31-1 ms to 1 ms; the mock now waits for such schedules in steps, as it already does for far-away cron expressions, and fires once per interval.
