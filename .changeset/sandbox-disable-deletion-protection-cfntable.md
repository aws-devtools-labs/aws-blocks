---
"@aws-blocks/core": patch
---

fix(core): make `SandboxDisableDeletionProtection` actually disable DynamoDB deletion protection

The mixin duck-typed only on the `deletionProtection` property name, but the
DynamoDB L1 `CfnTable` behind an L2 `Table` spells it
`deletionProtectionEnabled` — and the L2 `Table` never re-exposes the prop. As a
result the mixin silently never matched DynamoDB tables: sandbox stacks synthed
`DeletionProtectionEnabled: true` and `sandbox:destroy` failed on every
protected table, because DynamoDB refuses `DeleteTable` while protection is on
regardless of the CloudFormation `DeletionPolicy`.

The mixin now matches both the `deletionProtection` and
`deletionProtectionEnabled` spellings, so DynamoDB tables are cleared through
their L1 and consumers no longer need a local `CfnTable` workaround loop.
Behavior for other resource types is unchanged: only explicitly-enabled
protection is flipped, so unprotected resources still omit the property (Aurora
DB instances continue to synth without `DeletionProtection`).
