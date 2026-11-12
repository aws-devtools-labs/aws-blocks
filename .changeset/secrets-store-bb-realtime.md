---
"@aws-blocks/bb-realtime": minor
---

The connection token key now follows `defaults.secretsStore`. Sandbox stacks keep the SSM SecureString, and their template does not change.

**Behavior change on upgrade for production stacks:** with `BlocksPresets.production`, the key moves to a new Secrets Manager secret with a new value. Open WebSocket connections keep working. On their next reconnect, clients that pass `refresh` to `subscribe()` get new tokens; clients without it receive `onDisconnect('error')` and must call `getChannel()` again. To keep the existing key, set `secretsStore: 'ssm'` in `defaults` before you deploy this version; synth then emits the `@aws-blocks/bb-secret:SsmSecretsStoreOutsideSandbox` warning. The old SSM parameter is deleted by the deploy.
