---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

Before they deploy, `npm run deploy` and `npm run sandbox` now print the deployment target: the credentials that CDK deploys with (an AWS profile, access keys from the environment, or container or web identity credentials) and the configured Region. As in CDK, access keys from the environment (including the `AMAZON_` names that CDK also reads) are used before `AWS_PROFILE` unless `cdk.json` sets a profile; the credential check now verifies those keys rather than the profile. When the credential check succeeds, they also show the account name and the AWS account plan (Free or Paid, with its status), read with the same credentials that the check verified. These reads are optional and never stop a deploy. If they are denied, unsupported, empty, malformed or take longer than 2.5 seconds, the value shows as "not available". Account IDs, ARNs, error text and plan credits are not printed. `npm run destroy` and `npm run sandbox:destroy` print only the deployment target.

When the credentials are the AWS-managed role from the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, read with `iam:GetRole`), the output also has a one-line link to `https://settings.aws.com/billing` for spend limits, with a reminder to check that the project selected there matches the deployment target. Other credentials, or a role that cannot be read in time, get no link. When a profile has no Region, the warning now explains how to use `aws login`: set the profile Region to your project's Region before you sign in, and sign in again after you change it.

`@aws-blocks/core` now depends on `@aws-sdk/client-account`, `@aws-sdk/client-freetier` and `@aws-sdk/client-iam`. They load only when a deploy command runs.
