---
"@aws-blocks/bb-auth-oidc": patch
---

fix: `AuthOIDC.signInRoutePath()` works during `cdk synth`

`signInRoutePath()` only derives a path from `callbackPath`, so it now returns the same path under `cdk` as at runtime
(for example to build a sign-in link or a `RawRoute` path at module scope).
