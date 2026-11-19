---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/blocks": patch
---

Speed up local CronJob startup for sparse cron schedules with a time zone by reusing the formatter during each search for the next occurrence. Scheduled times are unchanged.
