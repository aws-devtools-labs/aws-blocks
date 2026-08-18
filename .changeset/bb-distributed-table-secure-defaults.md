---
"@aws-blocks/bb-distributed-table": patch
---

`DistributedTable`: make production DynamoDB tables secure by default, and add options to tune it.

Previously every table this block provisioned shipped with Point-in-Time Recovery disabled, deletion protection off, no explicit SSE-KMS, and CDK's default removal policy — so a stray `cdk destroy` could permanently and unrecoverably delete customer data, and at-rest data used an AWS-owned key with no CloudTrail auditability.

Durability posture now comes from the stack-wide **`BlocksDefaults`** (see `BlocksPresets` in `@aws-blocks/core/cdk`): a `production` stack retains + protects + backs up its tables, a `sandbox` stack is disposable. So on a production deploy a table defaults to:

- **Point-in-Time Recovery** enabled (`defaults.pointInTimeRecovery`) — 35-day continuous backups
- **Deletion protection** enabled (`defaults.deletionProtection`)
- **`RemovalPolicy.RETAIN`** (`defaults.removalPolicy`) — stack deletion orphans rather than destroys the table
- **SSE-KMS** with the AWS-managed `aws/dynamodb` key (auditable, no per-key charge)

Under the `sandbox` preset PITR, deletion protection, and RETAIN all flip off/`DESTROY`, so throwaway stacks stay cheap and `sandbox:destroy` tears down in one command. (The block no longer reads the `sandboxMode` context for durability — that posture flows through the stack `defaults`.)

Every default is overridable per table:

- `protection` (`'disposable' | 'retained' | 'locked'`) — one knob spanning removal policy + deletion protection, so the contradictory "protect + destroy" state can't be expressed. When set it wins over the stack `defaults`.
- `pointInTimeRecovery` (`boolean`) — overrides `defaults.pointInTimeRecovery` for this table; `pointInTimeRecoveryDays` (1–35, default 35) narrows the PITR recovery window to trim backup cost.
- `encryption` (`'aws-managed' | 'customer-managed'`, or `DistributedTable.fromKmsKey(arn)` to share an existing customer-managed key across tables instead of provisioning one CMK each).

Tables bound via `fromExisting()` are unaffected, and now emit a synth-time warning if durability/encryption options are passed alongside them (they're ignored). An unrecognized `protection`/`encryption` value, or an out-of-range `pointInTimeRecoveryDays`, also warns at synth rather than silently falling back.

> **Behavior change on next production deploy of an existing app:** the table will gain PITR, deletion protection, an SSE-KMS specification, and a `Retain` deletion policy (from the `production` preset). These are in-place updates (no table replacement). Because deletion protection becomes enabled, a future `cdk destroy` of a prod stack will refuse to delete the table until you relax it (`protection: 'disposable'`/`'retained'`). And because the removal policy is now `Retain`, deleting the stack orphans the table — redeploying the same app then fails with `Table already exists` until the orphaned table is removed or imported.
