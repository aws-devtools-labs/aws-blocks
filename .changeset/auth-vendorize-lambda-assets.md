---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` synthesizes when you vendorize it (`npm run vendorize -- Auth`). A vendorized copy contains only the TypeScript sources, so the handlers of the deploy-time Lambdas `Auth` creates — the user-pool immutability guard (every `Auth` with a user pool) and the identity-provider registration (social, SAML and Cognito-federated OIDC sign-in) — are bundled from the vendorized source at synth, and your edits to them deploy too. Installed (non-vendorized) apps use the pre-built handlers. Bundling uses your app's `esbuild`, which AWS Blocks apps already have as a dev dependency; if it is missing, synth tells you to install it.
