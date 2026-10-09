---
"@aws-blocks/core": patch
---

The AWS credential check before `npm run deploy` and `npm run sandbox` now finds the Region in your AWS profile and in `cdk.json`. Before, the check used only `AWS_REGION` and `AWS_DEFAULT_REGION`, and it did not run when the Region was set only in a profile. The secret upload to SSM now uses the same Region.
