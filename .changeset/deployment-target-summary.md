---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

Before they deploy, `npm run deploy` and `npm run sandbox` now print the deployment target: the AWS profile, or access keys from the environment, and the configured Region. When the credential check succeeds, they also show the account name and the AWS account plan (Free or Paid, with its status). These are read with the same credentials that the check verified; the credential chain runs once per command. These reads are optional and never stop a deploy. If they are denied, unsupported, empty, malformed or slower than about two seconds, the value shows as "not available". Account IDs, ARNs, error text and plan credits are not printed.

The output also has a one-line link to `https://settings.aws.com/billing` for spending limits, with a reminder to check that the workspace selected there matches the deployment target. When no Region is set, the warning now explains how to use `aws login`: set the profile Region to your project's Region before you sign in, and sign in again after you change it.

`@aws-blocks/core` now depends on `@aws-sdk/client-account` and `@aws-sdk/client-freetier`. They load only when a deploy command runs.
