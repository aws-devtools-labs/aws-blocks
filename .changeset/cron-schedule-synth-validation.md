---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/blocks": patch
---

`CronJob`: validate the schedule (and timezone) at synth so an invalid expression fails fast instead of after minutes of deploy.

The CDK layer passed `schedule`/`timezone` straight into the EventBridge `CfnSchedule` with no validation, so an invalid expression — e.g. `rate(10 seconds)` (EventBridge's minimum is 1 minute) or a malformed `cron(...)` — passed `cdk synth` and was only rejected by EventBridge minutes into provisioning. The mock already validated these, so local dev and deploy diverged.

The schedule/rate/cron parser and the timezone check are now a shared `schedule` module used by both the mock and the CDK construct. `CronJob`'s constructor validates up front and throws `CronJobErrors.InvalidSchedule` / `CronJobErrors.InvalidTimezone` at synth, before any infrastructure is created. No behavior change for valid schedules.
