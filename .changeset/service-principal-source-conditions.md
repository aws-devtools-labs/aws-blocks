---
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(bb-cron-job,hosting): scope service-principal trust and resource policies to this account

Add source-account/source-ARN conditions to two service-principal grants so they
only apply within the deploying account:

- **bb-cron-job**: the EventBridge Scheduler assume-role trust is now scoped by
  `aws:SourceAccount` and `aws:SourceArn` (schedule ARN), matching the AgentCore
  Runtime trust in `bb-agent`.
- **hosting**: the CloudFront `kms:Decrypt` grant on the SSE-KMS key is now scoped by
  `aws:SourceAccount` / `aws:SourceArn` to CloudFront distributions in this account.
