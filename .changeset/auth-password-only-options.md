---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` rejects `emailPassword: false` combined with `mfa` (other than `'off'`), `passkeys` or `users.deviceTracking` when you construct it, in `npm run dev`, at synth and in Lambda alike: these options apply only to email + password users, and federated users get MFA and passkeys from their identity provider. The error names each conflicting option and `emailPassword: false`, for example ``Auth 'auth': `mfa: 'required'` needs email + password sign-in, which `emailPassword: false` disables.`` The README quotes the exact compiler error for a gated call, and recommends keeping options in a variable declared `as const satisfies AuthOptions` (plain `satisfies AuthOptions` widens declared `users.groups` to `string[]`).
