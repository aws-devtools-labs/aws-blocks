---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/blocks": patch
---

Clarify event block compute compatibility and UnsupportedCompute errors: AsyncJob and CronJob support Lambda and container delivery, while Realtime requires default Lambda compute. Distinguish direct Lambda scheduling from the internal AsyncJob queue used by container CronJobs. Align both design documents and the AsyncJob comments with compute inheritance, retry paths, and backend-scoped Scheduler permissions for function and queue targets. Document that omitting container concurrency allows five in-flight deliveries per job per instance, rather than one per vCPU.
