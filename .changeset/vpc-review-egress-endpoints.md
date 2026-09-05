---
"@aws-blocks/core": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

fix(core): VPC review follow-ups — egress capability, endpoint trim, S3 gateway

Refines VPC support based on review feedback (all changes to the net-new,
unreleased VPC feature).

**`VpcRequirements.runtimeSubnet` becomes `requiresEgress?: boolean`.** A BB's
runtime need is a capability ("my code must reach the internet"), not a specific
subnet tier. Modeling it as a single role wrongly rejected a valid placement
(e.g. a BB needing egress placed in a `public` subnet). `finalizeVpc` now resolves
whether the runtime's placement actually provides egress — from the selected
subnets, not a guessed role — and validates `requiresEgress` against that. When
egress can't be determined (e.g. an imported VPC whose subnets aren't known at
synth) it warns rather than fabricating a pass/fail. `bb-distributed-data` (DSQL)
now declares `requiresEgress: true`.

**SSM interface endpoint is no longer always provisioned.** Only `AppSetting` and
the auth blocks (which compose `AppSetting`) use SSM, so it now flows from Building
Block requirements. An app that uses neither no longer pays for an unused interface
endpoint. CloudWatch Logs stays always-on (every in-VPC Lambda needs it for log
delivery).

**The S3 gateway endpoint is now always provisioned.** The runtime pulls config,
secrets, and migrations from S3 at cold start. Gateway endpoints are free
(route-table entries, no ENI), so this closes a real cold-start access gap at no
cost.
