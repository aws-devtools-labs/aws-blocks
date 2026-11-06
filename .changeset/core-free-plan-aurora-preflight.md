---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/create-blocks-app": patch
---

`npm run deploy` and `npm run sandbox` now stop before deploying an Aurora cluster to an account on the AWS Free plan. A Free-plan account can only create Aurora clusters with express configuration, so the `Database` default (Aurora Serverless v2) failed minutes into the deploy with `To use Aurora clusters with free plan accounts you need to set WithExpressConfiguration`. When the account plan that the credential check reads is Free, the commands check the synthesized templates, including those of CDK nested stacks. An `AWS::RDS::DBCluster` with an Aurora engine and without `WithExpressConfiguration` stops the deploy before any stack changes. The message lists each cluster by stack and construct path and the ways forward: upgrade to the Paid plan, use `DistributedDatabase`, or connect `Database` to an existing PostgreSQL database with `fromExisting()`. RDS Multi-AZ DB clusters (non-Aurora engines) are not affected. A cluster whose engine or express setting is only known at deploy time, or that has a CloudFormation `Condition` (on itself or on an enclosing nested stack), gets a warning and the deploy continues. The plan read is that of the account the credentials belong to, so only a stack without `env.account`, or with that account, can stop the deploy; its nested stacks deploy in the same account. A stack that deploys to another account, through its bootstrap roles, gets a warning. Nothing is checked on a Paid plan or when the plan is not available. Changes that `npm run sandbox` deploys later through `cdk watch` are not checked.

`npm run deploy` now synthesizes the app into its CDK output directory (`output` in `cdk.json`, by default `cdk.out`) and then deploys that assembly with `cdk deploy --app <dir>`, as `npm run sandbox` already did. The app is still synthesized once.
