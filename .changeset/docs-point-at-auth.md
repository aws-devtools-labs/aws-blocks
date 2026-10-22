---
'@aws-blocks/core': patch
'@aws-blocks/auth-common': patch
'@aws-blocks/bb-app-setting': patch
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/bb-knowledge-base': patch
'@aws-blocks/blocks': patch
---

Docs and editor hover text now point at `Auth`, the single authentication Building Block, instead of the removed `AuthBasic`, `AuthCognito` and `AuthOIDC`. The `@aws-blocks/blocks` README adds a "Choosing a sign-in method" table comparing email + password, social, direct OIDC, OIDC through Cognito, and SAML by Cognito free tier, offline support and user-pool features. The `hasAuthError` example in `@aws-blocks/core` now matches `AuthErrors.NotAuthorized`.
