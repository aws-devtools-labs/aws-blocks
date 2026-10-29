---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/blocks": patch
---

Clarify event block compute compatibility and UnsupportedCompute errors: AsyncJob supports Lambda and container delivery, CronJob requires resolved Lambda compute, and Realtime requires default Lambda compute. Align the AsyncJob design with both delivery paths and preserve the backend-scoped Scheduler role documentation.
