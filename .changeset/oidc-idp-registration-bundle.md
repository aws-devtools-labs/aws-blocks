---
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/blocks": patch
---

Fix `cognitoFederated()` failing at `cdk synth` with `CannotFindAsset`.

The published `@aws-blocks/bb-auth-oidc` package was missing the bundled Lambda that registers the identity provider on the user pool (`dist/idp-registration-lambda/index.js`), so any app using `cognitoFederated()` failed to synthesize. This affected both the Cognito-hosted domain prefix and custom domains. The release build now produces the bundle, so it ships with the package again.
