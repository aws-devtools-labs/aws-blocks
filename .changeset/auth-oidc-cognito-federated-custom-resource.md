---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/bb-app-setting": minor
"@aws-blocks/blocks": patch
---

fix(auth-oidc): make `cognitoFederated()` deployable by registering the IdP via a deploy-time custom resource

`@aws-blocks/bb-app-setting` now also exports `SECRETS_BULK_CONSTRUCT_ID` — the
construct id of the shared per-stack secret-init custom resource — so sibling
blocks can order a resource after the SecureString values are written without
hard-coding the string. `bb-auth-oidc`'s IdP-registration custom resource uses
it to take an explicit dependency on that resource (compile-time coupling, so a
rename can't silently break the ordering guarantee).

`cognitoFederated()` previously produced a CloudFormation template that always
failed to deploy (#447). It registered the federated identity provider with a
native `AWS::Cognito::UserPoolIdentityProvider` resource, writing the IdP
`client_id` / `client_secret` into `ProviderDetails` as
`{{resolve:ssm-secure:...}}` dynamic references. CloudFormation only permits
`ssm-secure` references on a small allowlist of properties that excludes
`ProviderDetails`, so `cdk synth` succeeded but every deploy failed at
change-set creation — before any resource was created — leaving the stack in
`REVIEW_IN_PROGRESS` with `SSM Secure reference is not supported in [...ProviderDetails...]`.

The IdP is now registered by a **deploy-time custom resource**: a small
Lambda-backed provider reads and decrypts the IdP credential SecureString
parameters via the SDK at deploy time and calls Cognito's
`CreateIdentityProvider` / `UpdateIdentityProvider` / `DeleteIdentityProvider`.
Only the parameter *names* cross into the CloudFormation template — the secret
values never appear in it. The handler's role is least-privilege: scoped to
`cognito-idp:{Create,Update,Delete}IdentityProvider` on the pool ARN,
`ssm:GetParameter` on the specific parameter ARNs, and `kms:Decrypt` conditioned
on `kms:ViaService = ssm.<region>`.

A `secret: true` `AppSetting` is an SSM SecureString at `/<fullId>` (not an AWS
Secrets Manager entry — the `blocks secret` CLI does not apply). Set its value by
writing the SecureString directly (`aws ssm put-parameter … --type SecureString
--overwrite`) or via the `AppSetting` runtime `put()`. Because the credentials
are read at deploy time and are not stack properties, the custom resource
re-reads SSM on every `cdk deploy`, so a credential set or rotation takes effect
on the next deploy. A synth-time check rejects two providers configured with the
same `identityProvider`.

Verified end-to-end against a real account: `cdk deploy` succeeds (no change-set
rejection) and the identity provider is created on the User Pool, including the
path where a real `AppSetting(secret: true)` provisions the SecureString during
the same deploy.

This is a `minor` bump for `@aws-blocks/bb-auth-oidc` (pre-1.0 minor = a behavior
change): the synthesized template for a `cognitoFederated()` provider no longer
contains a native `UserPoolIdentityProvider` resource — the IdP is now a custom
resource — so anyone asserting on that resource in a snapshot will see a diff.
The public API is unchanged.
