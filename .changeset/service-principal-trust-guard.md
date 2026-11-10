---
'@aws-blocks/core': patch
'@aws-blocks/bb-knowledge-base': patch
'@aws-blocks/bb-database': patch
'@aws-blocks/bb-distributed-table': patch
'@aws-blocks/blocks': patch
---

fix: scope every service-assumed role to this account with `aws:SourceAccount` and `aws:SourceArn`

- **KnowledgeBase:** the Bedrock role's trust now also requires `aws:SourceArn` to be one of this account's knowledge bases in this Region (`arn:<partition>:bedrock:<region>:<account>:knowledge-base/*`), next to the existing `aws:SourceAccount`.
- **Database and DistributedTable:** the Step Functions waiter role of their deployment custom resources now trusts only this account's state machines (`aws:SourceAccount` plus `aws:SourceArn` like `arn:<partition>:states:<region>:<account>:stateMachine:*`). Before, any state machine could be named as the caller.
- **BlocksStack and BlocksBackend:** at synth, every role AWS Blocks creates is checked. A role that an AWS service can assume without both keys gets a `blocks:iam:unscopedServiceTrust` warning; synth doesn't fail. Lambda and Lambda@Edge execution roles and API Gateway's account-level CloudWatch Logs role are exempt, because AWS documents their trust policies without these keys. In a `BlocksStack`, this includes roles you add to the stack yourself. Acknowledge the warning with `Annotations.of(scope).acknowledgeWarning('blocks:iam:unscopedServiceTrust')`, which matters under `cdk synth --strict`.
