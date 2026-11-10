---
'@aws-blocks/bb-auth-oidc': patch
'@aws-blocks/blocks': patch
---

The stub IdP engine is loaded only in sandbox deployments, and the deployed runtime does not accept stub providers outside a sandbox. `getClient()` and the signed-out sign-in actions list only the providers the runtime serves.
