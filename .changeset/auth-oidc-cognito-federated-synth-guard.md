---
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/blocks": patch
---

fix(auth-oidc): fail fast at synth when `cognitoFederated()` is configured, instead of emitting an undeployable template

`cognitoFederated()` produced a CloudFormation template that always failed to
deploy. The CDK layer registered the federated identity provider by writing the
IdP `client_id` / `client_secret` into
`AWS::Cognito::UserPoolIdentityProvider.ProviderDetails` as
`{{resolve:ssm-secure:...}}` dynamic references, but CloudFormation only permits
`ssm-secure` references on a small allowlist of properties that excludes
`ProviderDetails`. `cdk synth` succeeded, so the problem was invisible until
`cdk deploy`, which failed at change-set creation — before any resource was
created — leaving the stack in `REVIEW_IN_PROGRESS`.

AuthOIDC now surfaces this limitation at **synth** time: configuring a
`cognitoFederated()` provider registers a synth error (via CDK annotations) that
aborts deploy with an actionable message naming the offending provider(s) and
pointing at the self-hosted runtime providers — `google()`, `github()`,
`customOidc()`, `customOauth2()` — which resolve IdP credentials at runtime via
`AppSetting.get()` (not through CloudFormation) and deploy cleanly. This is a
strict DX improvement: the path was 100% undeployable before, so no working
configuration is affected. The README and DESIGN docs document the limitation
and the deploy-time custom-resource fix that will eventually lift it.
