---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/blocks": patch
---

Clarify event block compute compatibility and UnsupportedCompute errors: AsyncJob and CronJob support Lambda and container delivery, while Realtime requires default Lambda compute. Distinguish direct Lambda scheduling from the internal AsyncJob queue used by container CronJobs. Align the AsyncJob design and timeout comments with both delivery paths, and document backend-scoped Scheduler permissions for function and queue targets.
