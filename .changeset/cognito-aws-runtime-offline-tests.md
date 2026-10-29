---
'@aws-blocks/bb-auth-cognito': patch
'@aws-blocks/blocks': patch
---

Internal: test coverage. The `AuthCognito` AWS runtime now has offline tests that run on every build, against a stubbed Cognito client: sign-in, sign-up, sign-out, session refresh, cookie verification, error mapping, and live group checks. No runtime behaviour changes.
