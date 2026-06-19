---
"@aws-blocks/bb-cron-job": patch
---

fix(bb-cron-job): respect the upper bound of stepped cron ranges (e.g. `0-30/10`) instead of stepping past it, and reject inverted (`30-10`) or out-of-bounds (`100`, `0-100/5`) field values instead of silently producing empty or invalid schedules
