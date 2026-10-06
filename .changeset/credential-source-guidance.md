---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message now names the profile and the command that fixes its credentials. A profile without credentials gets sign-up and `aws login` guidance, with an AWS CLI install or update hint when the installed CLI does not have `aws login`. Expired `aws login` and IAM Identity Center (SSO) sessions get `aws login` or `aws sso login` for that profile. Rejected access keys, `credential_process`, web identity and environment credentials get guidance for that source. When AWS cannot be reached, including the SSO portal, the deploy still continues, and the warning now says that AWS could not be reached. The deploy docs and the generated app's `AGENTS.md` describe this behavior.

`@aws-blocks/core` now requires AWS SDK for JavaScript clients 3.936.0 or later, the first version that reads credentials from `aws login` profiles.
