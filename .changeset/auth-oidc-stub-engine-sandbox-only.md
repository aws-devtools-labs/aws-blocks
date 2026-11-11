---
'@aws-blocks/bb-auth-oidc': patch
'@aws-blocks/blocks': patch
---

The stub IdP engine is loaded only in sandbox deployments, and the deployed runtime does not accept stub providers outside a sandbox. `getClient()` and the signed-out sign-in actions list only the providers the runtime serves.

With `cognitoFederated()` configured, a non-Cognito provider in the same `providers` array (for example `google()`) is now left out of `getClient()` and the sign-in actions, with a warning logged once per provider; previously `getClient()` threw for that configuration.
