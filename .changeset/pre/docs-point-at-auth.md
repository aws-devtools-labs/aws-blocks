---
'@aws-cdk-blocks/core': patch
'@aws-cdk-blocks/auth-common': patch
'@aws-cdk-blocks/bb-app-setting': patch
'@aws-cdk-blocks/bb-kv-store': patch
'@aws-cdk-blocks/bb-knowledge-base': patch
'aws-cdk-blocks': patch
---

Docs and editor hover text now point at `Auth`, the single authentication Building Block, instead of the removed `AuthBasic`, `AuthCognito` and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table comparing email + password, social, OIDC verified by your backend (`store: 'builtin'`), OIDC through Cognito, and SAML by Cognito free tier, offline support and user-pool features. The `hasAuthError` example in `@aws-cdk-blocks/core` now matches `AuthErrors.NotAuthorized`.
