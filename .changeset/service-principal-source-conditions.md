---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(bb-cron-job,hosting): scope service-principal grants to the deploying account

- **bb-cron-job**: the EventBridge Scheduler role's trust policy is now limited to
  schedules in the stack's account and region (`aws:SourceAccount` and an `aws:SourceArn`
  schedule-group pattern).
- **hosting**: removed a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key
  policy. The Origin Access Control wiring already grants CloudFront decrypt on the bucket key,
  conditioned on `AWS:SourceArn` matching the account's CloudFront distributions.
