---
"@aws-blocks/core": patch
---

feat(core): add a shared Blocks execution role and `Scope.executionRole` getter

The Blocks stack/backend now provisions one explicit IAM role (with
`AWSLambdaBasicExecutionRole` attached) that the handler assumes, and exposes it
as `executionRole`. A new `Scope.executionRole` getter resolves the role from
any Building Block. Additive and non-breaking: the same handler is created, now
backed by an explicit role instead of an auto-generated one, with block grants
sitting on the role's default policy exactly as before.

Migration note: on an existing deployed stack, upgrading replaces the Lambda
execution role — CloudFormation deletes the old auto-generated role and creates
the new `BlocksRole`. This is runtime-equivalent (the same grants re-attach to
the new role) and needs no action, but a change-set diff will show a role
delete+create rather than a no-op.
