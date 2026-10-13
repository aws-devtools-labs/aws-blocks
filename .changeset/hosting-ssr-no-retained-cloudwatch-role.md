---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(hosting): stop the SSR REST API from leaking an IAM role on every teardown

The SSR origin's `RestApi` relied on CDK's default `cloudWatchRole: true`, which
provisions an account-level `AWS::ApiGateway::Account` plus a CloudWatch Logs IAM
role with `RemovalPolicy.RETAIN`. The SSR stage enables neither execution nor
access logging, so the role was unused, and because it is retained, every
`cdk destroy` of a hosting SSR stack left one orphaned IAM role behind — enough,
over repeated deploys, to exhaust the account's 3000 `RolesPerAccount` quota and
make all subsequent deploys fail with `ServiceLimitExceeded`. The SSR `RestApi`
now sets `cloudWatchRole: false` (matching `bb-lambda-compute`), so no role or
`ApiGateway::Account` is created. Existing stacks drop both resources on their
next deploy; the previously retained role is not removed by CloudFormation and
can be deleted manually — but first check `aws apigateway get-account`: if the
region's `cloudwatchRoleArn` still points at that role, deleting it breaks
logging for every other API Gateway stage in the region.
