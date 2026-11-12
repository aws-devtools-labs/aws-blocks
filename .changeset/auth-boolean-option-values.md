---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` checks the values of its boolean options at construction, in `npm run dev`, at synth and in Lambda alike. A non-boolean `selfSignUp` is rejected at construction, so `emailPassword: { selfSignUp: 0 }` from untyped code can't turn self-service sign-up **on** (only `false` disables it). The same applies to every other boolean option (`autoSignIn`, `revealExistingUsers`, the `passwordPolicy.require*` flags, `deletionProtection`, `session.crossDomain`, `users.deviceTracking`, `users.attributes[].mutable` / `required`, `users.caseSensitive`, and a SAML provider's `signRequest`), and `emailPassword`, `passkeys` and `allowBearerAuth` must be a boolean or an options object. The error names each option and the value it got, for example ``- `emailPassword.selfSignUp` must be `true` or `false`, got the number 0``. TypeScript code that compiles is unaffected.
