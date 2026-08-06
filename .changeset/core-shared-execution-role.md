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
