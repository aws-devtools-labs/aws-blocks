---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/blocks": minor
---

**Breaking (deploy):** `stubIdp()` providers are now local and sandbox only.

- `cdk synth` throws when an `AuthOIDC` instance has a `stubIdp()` provider and the deploy isn't in sandbox mode (`npm run sandbox` sets the `sandboxMode` context; `npm run deploy` doesn't). The error names the provider.
- A deployed Lambda refuses to mount stub IdP routes unless the CDK layer recorded a sandbox deploy, so an artifact built without the synth check fails closed.
- The stub's authorization codes are signed with a key generated per process from a cryptographically secure random source, instead of a constant in the package source, and the signature is compared in constant time.

Local development (`npm run dev`) and sandboxes are unchanged. A production app that declared a `stubIdp()` provider must replace it with a real provider (`google()`, `github()`, `customOidc()`, `cognitoFederated()`), or choose providers by environment.
