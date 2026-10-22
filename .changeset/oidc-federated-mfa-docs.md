---
'@aws-blocks/bb-auth-oidc': patch
'@aws-blocks/blocks': patch
---

Corrected the `AuthOIDC` docs for `cognitoFederated()`. They previously said Cognito federation adds MFA, adaptive authentication, and brute-force protection to social sign-in. It doesn't: for federated users, Amazon Cognito delegates authentication to the identity provider and offers no extra authentication factors, device tracking, or threat protection. The README and JSDoc now say so and tell you to enforce MFA at the IdP (for example Google 2-Step Verification, or your Okta / Microsoft Entra ID MFA policy). No behavior changes.
