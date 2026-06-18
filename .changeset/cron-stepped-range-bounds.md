---
"@aws-blocks/bb-cron-job": patch
---

fix(bb-cron-job): respect the upper bound of stepped cron ranges (e.g. `0-30/10`) instead of stepping past it
