---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-cron-job": patch
---

Correct API docs: `AsyncJob`'s `maxRetries` counts total delivery attempts including the first; the `DashboardErrors` example now compiles and catches `InvalidMetricConfig` where it is thrown (when dashboards are finalized, not in the constructor), and an omitted `metricConfigs` renders no metrics section; `CronJobEvent.jobName` is the CronJob's fully-qualified id, not the bare constructor id.
