---
"@aws-cdk-blocks/create-blocks-app": patch
---

`create-blocks-app` no longer writes a `stackId` that starts with `aws` to `.cdk-blocks/config.json`. A name that starts with `aws` in any letter case, such as a directory named `aws-demo` or a package named `AWS-Shop`, now gets the prefix `app-`, as a name that starts with a digit does: `aws-demo` gives `app-aws-demo-9f3a2b`. Before, the deploy of such an app failed in CloudFormation after other resources were created, because AWS Resource Groups refuses a group name that starts with `AWS` and each stack names two groups after itself. A name that does not start with `aws` gives the same `stackId` as before. Existing apps are not changed.
