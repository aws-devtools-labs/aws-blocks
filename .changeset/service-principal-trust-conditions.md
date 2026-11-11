---
"@aws-blocks/core": minor
"@aws-blocks/hosting": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-container-compute": patch
"@aws-blocks/bb-database": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/blocks": minor
---

fix(core): add aws:SourceAccount/aws:SourceArn conditions to service-principal trust policies; add synth-time check

The IAM roles AWS Blocks creates for a backend now scope every service-principal trust to the stack's account:

- The API Gateway account-level CloudWatch role (`BlocksApiGatewayCloudWatchRole`, created by `@aws-blocks/core` and `@aws-blocks/hosting` when access logging is on) trusts `apigateway.amazonaws.com` only with `aws:SourceAccount` set to the stack account and `aws:SourceArn` matching `arn:<partition>:apigateway:<region>::*`.
- The `KnowledgeBase` Bedrock service role adds `aws:SourceArn` matching `arn:<partition>:bedrock:<region>:<account>:knowledge-base/*` beside its existing `aws:SourceAccount` condition.
- The waiter state machine roles of the `DistributedTable` index provider and the `Database` migration provider trust `states.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:states:<region>:<account>:stateMachine:*`.
- The `ContainerCompute` task execution role trusts `ecs-tasks.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:ecs:<region>:<account>:*`, the same scope as its task-role trust.
- The `AuthCognito` SMS role (created for phone sign-in or SMS MFA) trusts `cognito-idp.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:cognito-idp:<region>:<account>:userpool/*`, beside the `sts:ExternalId` it already had.
- The `@aws-blocks/hosting` API Gateway REST door no longer creates CDK's per-API CloudWatch role and `AWS::ApiGateway::Account` setting; its stage configures no logging.

Synth now checks the roles AWS Blocks covers for a backend for a service-principal trust with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition. That is the same set of roles `defaults.permissionsBoundary` applies to: for a `BlocksStack` the whole stack, for an embedded `BlocksBackend` its subtree and the stack-level roles created on its behalf. Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`) are accepted as they are.

- A role AWS Blocks creates (under a Building Block or a compute, or at stack scope on a block's behalf) fails synth; the error names the role's construct path and the principal.
- A role the app adds to a `BlocksStack` itself, including one a CDK construct creates inside it (for example the `EventsRole` of an `events.Rule` targeting a state machine), gets a synth warning instead, and synth succeeds.

To resolve the warning, add both conditions to the role's trust statement. For a role a CDK construct creates with no prop for its trust, set them with `role.node.defaultChild.addPropertyOverride('AssumeRolePolicyDocument.Statement.N.Condition', { ... })`; the warning names `N`. To keep the trust as it is, acknowledge the warning with `Annotations.of(role).acknowledgeWarning('@aws-blocks/core:serviceRoleTrustWithoutSourceCondition')`, or on the stack for every role in it. See "Service-principal trust" in the `@aws-blocks/core` README.
