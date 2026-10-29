---
"@aws-blocks/bb-realtime": minor
---

The connection token key now follows `defaults.secretsStore`. Sandbox stacks keep the SSM SecureString, and their template does not change.

**Behavior change on upgrade for production stacks:** with `BlocksPresets.production`, the key moves to a new Secrets Manager secret with a new value. Open WebSocket tokens are rejected once and clients reconnect. To keep the existing key, set `secretsStore: 'ssm'` in `defaults`; synth then emits the `@aws-blocks/bb-secret:SsmSecretsStoreOutsideSandbox` warning. The old SSM parameter is deleted by the deploy.
