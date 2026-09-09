---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/blocks": patch
---

fix(auth-oidc): make `cognitoFederated()` deployable by registering the IdP via a deploy-time custom resource

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
`cognito-idp:*IdentityProvider` on the pool ARN, `ssm:GetParameter` on the
specific parameter ARNs, and `kms:Decrypt` conditioned on
`kms:ViaService = ssm.<region>`. Set the credential values with `blocks secret`
before deploying; a deploy with unset credentials fails fast with an actionable
message.

Verified end-to-end against a real account: `cdk deploy` succeeds (no change-set
rejection) and the identity provider is created on the User Pool.

This is a `minor` bump for `@aws-blocks/bb-auth-oidc` (pre-1.0 minor = a behavior
change): the synthesized template for a `cognitoFederated()` provider no longer
contains a native `UserPoolIdentityProvider` resource — the IdP is now a custom
resource — so anyone asserting on that resource in a snapshot will see a diff.
The public API is unchanged.
