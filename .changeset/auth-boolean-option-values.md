---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` now checks the values of its boolean options at construction, in `npm run dev`, at synth and in Lambda alike. A non-boolean `selfSignUp` is now rejected at construction: before, `emailPassword: { selfSignUp: 0 }` from untyped code turned self-service sign-up **on**, because only `false` disables it. The same applies to every other boolean option (`autoSignIn`, `revealExistingUsers`, the `passwordPolicy.require*` flags, `allowBearerAuth`, `deletionProtection`, `session.crossDomain`, `users.deviceTracking`, `users.attributes[].mutable` / `required`, a SAML provider's `signRequest` and `stubIdp`'s `unsafeAllowDeployed`), and `emailPassword` and `passkeys` must be a boolean or an options object. The error names each option and the value it got, for example ``- `emailPassword.selfSignUp` must be `true` or `false`, got the number 0``. TypeScript code that compiles is unaffected.
