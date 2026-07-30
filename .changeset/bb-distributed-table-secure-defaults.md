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

Every default is overridable per table via new options — `pointInTimeRecovery`, `deletionProtection`, `encryption` (`'aws-managed' | 'customer-managed'`), and `removalPolicy` (`'retain' | 'destroy'`). Explicit values always win over the environment default. Tables bound via `fromExisting()` are unaffected.

> **Behavior change on next production deploy of an existing app:** the table will gain PITR, deletion protection, an SSE-KMS specification, and a `Retain` deletion policy. These are in-place updates (no table replacement). Because deletion protection becomes enabled, a future `cdk destroy` of a prod stack will refuse to delete the table until you disable protection or pass `deletionProtection: false`.
