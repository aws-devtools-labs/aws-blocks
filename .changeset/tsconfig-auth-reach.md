---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

chore(bb-auth-cognito): declare the `@aws-blocks/bb-app-setting` TypeScript project reference

Build-only change with no runtime effect: the package's TypeScript project now
declares its dependency on `@aws-blocks/bb-app-setting`, and the repository build
type-checks `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc` directly, so
their compile-time type tests always run.
