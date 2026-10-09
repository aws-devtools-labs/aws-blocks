---
'@aws-blocks/blocks': patch
'@aws-blocks/bb-auth': patch
---

`getSdkIdentifiers(auth)` for an `Auth` block is typed with optional fields (`userPoolId`, `clientId`, `region`, `hostedUiDomain`, `hostedUiClientId`), matching what `Auth` registers. An `Auth` whose only sign-in methods are directly federated OIDC providers has no user pool and registers none of them, so code that reads `userPoolId` must check that it is defined.

The sign-in pricing tables (`Auth`'s "Which option and why" and the umbrella's "Choosing a sign-in method") note that Cognito's Plus plan has no free tier for email + password and social users ($0.020 per MAU), confirm that SAML / OIDC federated users cost $0.015 per MAU above 50 on every plan, and cite the Cognito pricing page and the date it was read.
