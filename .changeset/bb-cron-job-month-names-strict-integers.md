---
"@aws-blocks/bb-cron-job": patch
---

Accept month names (`JAN`–`DEC`, case-insensitive) in the local mock's cron month field, so schedules like `cron(0 9 1 JAN ? *)` and `cron(0 9 ? JAN-MAR MON *)` fire locally instead of throwing `InvalidScheduleExpression`. Cron field values must now be whole integers: values with trailing characters such as `9am`, `30m`, `1st` or `0/15x` throw `InvalidScheduleExpression` instead of being silently truncated and scheduled.
