---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

Fail fast on an invalid stack name instead of after minutes of provisioning.

`BlocksStack.create` now validates the stack name up front against the CloudFormation stack-name contract (must start with a letter; only letters, digits, and hyphens; ≤128 characters). An invalid name — e.g. one containing underscores — previously passed `cdk synth` and only failed with an opaque `StackNameInvalidFormat` well into CloudFormation provisioning. It now throws immediately at synth with an actionable message and a suggested valid name, before any infrastructure is created.

The validation lives in a single shared `assertValidStackName` at the naming chokepoint (every resource name derives from the stack name via `fullId`), so it is the one place the name contract is enforced. No behavior change for valid stack names.
