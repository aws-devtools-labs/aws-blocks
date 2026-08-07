---
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/blocks": patch
---

`DistributedTable`: make production DynamoDB tables secure by default, and add options to tune it.

Previously every table this block provisioned shipped with Point-in-Time Recovery disabled, deletion protection off, no explicit SSE-KMS, and CDK's default removal policy — so a stray `cdk destroy` could permanently and unrecoverably delete customer data, and at-rest data used an AWS-owned key with no CloudTrail auditability.

On a **production** deploy, tables now default to:

- **Point-in-Time Recovery** enabled (35-day continuous backups)
- **Deletion protection** enabled
- **SSE-KMS** with the AWS-managed `aws/dynamodb` key (auditable, no per-key charge)
- **`RemovalPolicy.RETAIN`** (stack deletion orphans rather than destroys the table)

In **sandbox mode** (`--context sandboxMode=true`) PITR and deletion protection stay off and the removal policy is `DESTROY`, so throwaway stacks remain cheap and `sandbox:destroy` still tears down in one command. SSE-KMS is on in both.

Every default is overridable per table via new options — `pointInTimeRecovery`, `pointInTimeRecoveryDays` (1–35, default 35 — narrow the PITR recovery window to trim backup cost), `protection` (`'disposable' | 'retained' | 'locked'` — one knob spanning removal policy + deletion protection, so the contradictory "protect + destroy" state can't be expressed), and `encryption` (`'aws-managed' | 'customer-managed'`, or `DistributedTable.fromKmsKey(arn)` to share an existing customer-managed key across tables instead of provisioning one CMK each). Explicit values always win over the environment default. Tables bound via `fromExisting()` are unaffected, and now emit a synth-time warning if durability/encryption options are passed alongside them (they're ignored). An unrecognized `protection`/`encryption` string also warns at synth rather than silently falling back.

> **Behavior change on next production deploy of an existing app:** the table will gain PITR, deletion protection, an SSE-KMS specification, and a `Retain` deletion policy (the `protection: 'locked'` default). These are in-place updates (no table replacement). Because deletion protection becomes enabled, a future `cdk destroy` of a prod stack will refuse to delete the table until you relax it (`protection: 'disposable'` or `'retained'`). And because the removal policy is now `Retain`, deleting the stack orphans the table — redeploying the same app then fails with `Table already exists` until the orphaned table is removed or imported.
