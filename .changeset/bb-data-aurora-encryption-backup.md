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
- **Automated backups** are on by default and retained **15 days**; this is also
  the point-in-time-recovery window. A single `pointInTimeRecovery` option
  controls it (mirroring every other Blocks block): `true` enables the 15-day
  window, `{ retentionDays: n }` pins a 1–35-day window, and `false` clamps to the
  1-day minimum (Aurora cannot disable automated backups). When omitted it follows
  the stack-wide `defaults.pointInTimeRecovery` (on under `production`, off under
  `sandbox`).
- **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
  Logs, with retention following the stack-wide `defaults.logRetention`.
- `iamAuthentication` remains intentionally off (access is exclusively via the RDS
  Data API), and automatic secret rotation is documented as a follow-up.

**Breaking for existing stacks (0.x minor = breaking channel):** these change the
synthesized cluster properties, so existing stacks will show a CloudFormation diff.

Enabling storage encryption on an already-provisioned, unencrypted cluster
requires a **replacement**, and the replacement is destructive: RDS cannot encrypt
an existing cluster in place, so CloudFormation creates a **new, empty** encrypted
cluster and repoints the stack. There is no in-place path. Under production
(RETAIN) the old cluster is orphaned/unreferenced and the app comes back against
the empty cluster with the migration CustomResource re-running (schema only, no
data); under sandbox (DESTROY) the old cluster and its data are deleted. The only
safe route is to snapshot the existing cluster, restore it with encryption enabled,
then cut over. Review the diff and snapshot before deploying.
