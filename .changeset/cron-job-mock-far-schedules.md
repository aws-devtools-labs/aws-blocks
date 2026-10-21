---
"@aws-blocks/bb-cron-job": patch
---

The local CronJob mock no longer runs a cron job on a date its schedule doesn't match. A schedule with no match within a year (such as `cron(0 0 29 2 ? *)`) used to fire an hour later; a fire time more than about 24.8 days away (such as a yearly schedule) used to fire right away because it overflowed `setTimeout`. Both now wait for the real fire time.
