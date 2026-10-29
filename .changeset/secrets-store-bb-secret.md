---
"@aws-blocks/bb-secret": minor
---

Add an internal `@aws-blocks/bb-secret/internal` entry point that AWS Blocks' own Building Blocks use to create their generated keys in the store chosen by `defaults.secretsStore`. In `'secrets-manager'` mode the key is a Secrets Manager secret with a generated name and value, deleted with the stack, and read only for the app. In `'ssm'` mode it is the same SSM SecureString as before. Synth warns (`@aws-blocks/bb-secret:SsmSecretsStoreOutsideSandbox`) when `'ssm'` is used on a stack that looks like production. The public `Secret` API and defaults are unchanged. `@aws-blocks/bb-secret` now depends on `@aws-blocks/bb-app-setting`.
