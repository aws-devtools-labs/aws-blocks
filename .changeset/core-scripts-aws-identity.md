---
"@aws-blocks/core": minor
---

feat(core): read the deploy identity and credentials without deploying

`@aws-blocks/core/scripts` adds functions for tools that show what a deploy would use before running it:

- `readAwsIdentity()` returns the AWS account, caller ARN, credentials and Region that a deploy would use, verified with STS GetCallerIdentity, without deploying. Missing, expired or rejected credentials throw the same guidance the deploy prints. When no Region is set, it returns the credentials without an AWS request.
- `describeDeploymentCredentials()` returns the credentials label that the deploy prints and the Region, from local configuration only and without an AWS request. When environment access keys take precedence over an exported `AWS_PROFILE`, the label says so (`access keys in AWS_ACCESS_KEY_ID (used instead of AWS_PROFILE)`) and `keysOverrideProfile` is `true`.
- `resolveDeploymentTarget()` is now exported.

`runSecretCli` and `runConfigCli` take the `interactive` and `yes` options of `@aws-blocks/hosting`'s value CLI and pass them through.
