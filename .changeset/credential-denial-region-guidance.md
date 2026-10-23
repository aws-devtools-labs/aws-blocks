---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

When AWS denies the credential check before `npm run deploy` and `npm run sandbox`, for example when a profile's role cannot be assumed, the warning now says so instead of reporting an unverified check, and says whether an AWS Organizations policy (a service control policy or a resource control policy) explicitly denied the request. It still does not stop the command, and it never includes the error's account IDs, ARNs or policy IDs.

A credential failure message now names the profile and the deployment Region. When the fix is `aws login` and the profile has no Region or a different one, the message first prints `aws configure set region <region> --profile <name>`, so that the sign-in uses the Region you deploy to, and says to sign in again after a later Region change. If the profile's Region is set in the AWS credentials file, which overrides the config file that `aws configure set` writes, the message asks you to change it there instead. When `AWS_REGION` or `AWS_DEFAULT_REGION` names another Region than the deployment, which the AWS CLI would use instead, the `aws login` command includes `--region <region>`.
