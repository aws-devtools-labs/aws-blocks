---
"@aws-blocks/create-blocks-app": patch
---

feat: add a `cron` template with scheduled CronJobs

`npx @aws-blocks/create-blocks-app my-app --template cron` scaffolds a
backend-only app with a `CronJob` that runs every minute and records each run
in a `KVStore`, plus a disabled job that shows `enabled: false`. The shipped
e2e test waits for the first scheduled run and checks that the disabled job
never fires.
