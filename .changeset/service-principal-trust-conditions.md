---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-container-compute": patch
"@aws-blocks/bb-database": patch
"@aws-blocks/blocks": patch
---

fix(core): add aws:SourceAccount/aws:SourceArn conditions to service-principal trust policies; add synth-time check

The IAM roles AWS Blocks creates for a backend now scope every service-principal trust to the stack's account:

- The API Gateway account-level CloudWatch role (`BlocksApiGatewayCloudWatchRole`, created by `@aws-blocks/core` and `@aws-blocks/hosting` when access logging is on) trusts `apigateway.amazonaws.com` only with `aws:SourceAccount` set to the stack account and `aws:SourceArn` matching `arn:<partition>:apigateway:<region>::*`.
- The `KnowledgeBase` Bedrock service role adds `aws:SourceArn` matching `arn:<partition>:bedrock:<region>:<account>:knowledge-base/*` beside its existing `aws:SourceAccount` condition.
- The waiter state machine roles of the `DistributedTable` index provider and the `Database` migration provider trust `states.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:states:<region>:<account>:stateMachine:*`.
- The `ContainerCompute` task execution role trusts `ecs-tasks.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:ecs:<region>:<account>:*`, the same scope as its task-role trust.
- The `@aws-blocks/hosting` API Gateway REST door no longer creates CDK's per-API CloudWatch role and `AWS::ApiGateway::Account` setting; its stage configures no logging.

Synth now fails when a role AWS Blocks covers for a backend trusts a service principal with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition. That is the same set of roles `defaults.permissionsBoundary` applies to: for a `BlocksStack` the whole stack, including roles the app adds to it; for an embedded `BlocksBackend` its subtree and the stack-level roles created on its behalf. The error names the role's construct path and the principal; add both conditions to the role's trust statement to resolve it. Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`) are accepted as they are.
