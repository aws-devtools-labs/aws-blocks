---
"@aws-blocks/bb-data": minor
"@aws-blocks/blocks": minor
---

fix(bb-data): enable Aurora storage encryption, backup retention, and log export

Hardens the Aurora Serverless v2 cluster synthesized by `Database`:

- **Storage encryption at rest** is opt-in via the
  `@aws-blocks/bb-data:encryptStorageByDefault` context flag — set in the new
  `create-blocks-app` cdk.json templates, so new projects encrypt by default with
  the AWS-managed `aws/rds` key. A new optional `storageEncryptionKeyArn` (the ARN
  of a customer-managed KMS key) turns encryption on regardless of the flag and
  also encrypts the auto-generated credentials secret. When neither is set, the
  `StorageEncrypted` property is left unset (so an existing cluster is untouched)
  and a synth warning explains how to opt in.
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

**Breaking for existing stacks (0.x minor = breaking channel):** the
backup-retention and CloudWatch log-export changes alter synthesized cluster
properties, so existing stacks will show a CloudFormation diff.

Storage encryption is **opt-in** specifically so it does **not** silently replace
existing clusters: with neither the context flag nor a `storageEncryptionKeyArn`
set, the `StorageEncrypted` property is left unset and the existing cluster is
untouched. Opting in (setting the flag, or supplying a key) on an
already-provisioned, unencrypted cluster requires a **replacement**, and the
replacement is destructive: RDS cannot encrypt an existing cluster in place, so
CloudFormation creates a **new, empty** encrypted cluster and repoints the stack.
There is no in-place path. The migration CustomResource does **not** re-run on a
cluster swap — its only CloudFormation properties are the service token and the
migrations hash, neither of which changes when the cluster is replaced — so the new
cluster comes up with **no schema**; migrations run only when a migration file
changes (which changes the migrations hash). Under production (RETAIN) the old
cluster is orphaned/unreferenced; under sandbox (DESTROY) it and its data are
deleted; under `removalPolicy: 'snapshot'` it is snapshotted as it is replaced
(though under production's `deletionProtection: true` the follow-up delete may fail
and leave it in place, unverified on a real deploy). The only safe route is to
snapshot the existing cluster, restore it with encryption enabled, then cut over.
Review the diff and snapshot before deploying. The replacement is symmetric:
turning encryption back off — removing the flag (or `storageEncryptionKeyArn`) from
a project that already deployed encrypted, e.g. deleting the cdk.json line or a
merge dropping it — also changes `StorageEncrypted` and so likewise replaces the
cluster (back to unencrypted), with the same new-empty-cluster / no-schema outcome.
