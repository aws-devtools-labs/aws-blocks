---
"@aws-blocks/bb-auth": minor
---

The `session-secret` (the HMAC key that signs session cookies and sign-in challenges) now follows `defaults.secretsStore`. Sandbox stacks keep the SSM SecureString, and their template does not change.

**Behavior change for production stacks, including apps switching from `AuthCognito`:** with `BlocksPresets.production`, the key moves to a new Secrets Manager secret with a new value, so every signed-in user is signed out once and sign-ins in progress start again. Users and passwords are not affected. To keep the existing key, set `secretsStore: 'ssm'` in `defaults` before you deploy this version; synth then emits the `@aws-blocks/bb-secret:SsmSecretsStoreOutsideSandbox` warning. Signed-in sessions end in both cases in this release, because the session store is a new table.
