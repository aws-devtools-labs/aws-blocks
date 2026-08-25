---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/bb-lambda-compute": patch
---

`RestApi`: do not create the account-level API Gateway CloudWatch role.

CDK sets `cloudWatchRole: true` by default on `RestApi`. This default creates two resources:

- An IAM role with `RemovalPolicy.RETAIN`. The role stays after you delete the stack.
- `AWS::ApiGateway::Account`. This resource is a singleton for each account and each region.

Both resources cause failures in an account that deploys many stacks:

- The retained roles increase until the account reaches the IAM limit of 1500 roles. Every new stack then fails with `ServiceLimitExceeded: RolesPerAccount 1500`.
- Two deploys that run at the same time write the same singleton. API Gateway returns HTTP 429. The stack create fails and rolls back.

The rollback makes the second failure permanent. CloudFormation deletes the S3 bucket before it creates the CDK auto-delete custom resource. The bucket keeps its object versions, so the delete fails and the stack stops in `DELETE_FAILED`. That stack retains every IAM role it holds, which makes the role leak worse.

This change sets `cloudWatchRole: false` at all three `RestApi` call sites: `@aws-blocks/core` (`BlocksBackend`), `@aws-blocks/hosting` (the SSR origin), and `@aws-blocks/bb-lambda-compute`. No block turns on API Gateway execution logging, so the role has no use.

**Behavior change:** a deploy no longer sets the account-level CloudWatch role for API Gateway. To use API Gateway execution logging, set that role one time for the account, outside the stack. Access logging on a stage does not use this role, and it continues to work.
