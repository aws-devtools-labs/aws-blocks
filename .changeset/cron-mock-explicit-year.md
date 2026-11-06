---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/blocks": patch
---

Reject cron year restrictions in the local mock with `CronJobErrors.ScheduleNotSupported` instead of silently ignoring them and scheduling jobs in the wrong year. Malformed and out-of-range year restrictions throw `CronJobErrors.InvalidSchedule`, and AWS deployment continues to preserve the original schedule expression.
