---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

When `npm run deploy` or `npm run sandbox` cannot store the database connection string in SSM Parameter Store, the error now explains why instead of showing the raw AWS error: expired or invalid credentials (with the same sign-in or refresh guidance as the credential check), access denied, or no network. It says that an AWS Organizations policy (a service control policy or a resource control policy) denied the request only when AWS reports that explicit deny. The message never includes the error's account IDs, ARNs or policy IDs. The command still fails, and the error keeps the AWS error name.

The connection string is now stored with the same credentials that CDK deploys with: access keys from the environment are used before `AWS_PROFILE` unless `cdk.json` sets a profile, as in the credential check. Before, with both set, the parameter could be written with the `AWS_PROFILE` credentials, possibly in another account.
