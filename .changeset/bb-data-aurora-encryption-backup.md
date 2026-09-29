---
"@aws-blocks/bb-data": minor
"@aws-blocks/blocks": minor
---

fix(bb-data): enable Aurora storage encryption, backup retention, and log export

Hardens the Aurora Serverless v2 cluster synthesized by `Database`:

- **Storage encryption at rest** is now enabled explicitly (`storageEncrypted: true`),
  using the AWS-managed `aws/rds` key by default. A new optional
  `storageEncryptionKeyArn` (the ARN of a customer-managed KMS key) selects a
  customer-managed key, which also encrypts the auto-generated credentials secret.
- **Automated backups** are retained **15 days** by default (new optional
  `backupRetentionDays` override, a number of days); this is also the
  point-in-time-recovery window.
- **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
  Logs, with retention following the stack-wide `defaults.logRetention`.
- `iamAuthentication` remains intentionally off (access is exclusively via the RDS
  Data API), and automatic secret rotation is documented as a follow-up.

**Breaking for existing stacks (0.x minor = breaking channel):** these change the
synthesized cluster properties, so existing stacks will show a CloudFormation diff.
In particular, enabling storage encryption on an already-provisioned, unencrypted
cluster requires a **replacement** of the cluster. Review the diff before deploying.
