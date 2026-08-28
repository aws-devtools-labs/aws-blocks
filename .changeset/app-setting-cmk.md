---
"@aws-blocks/bb-app-setting": minor
"@aws-blocks/blocks": patch
---

`AppSetting`: support a customer-managed KMS key for secrets via `kmsKeyArn`.

Secret (`SecureString`) parameters were always encrypted with the default `aws/ssm` AWS-managed key, so their decrypt scope couldn't be controlled (e.g. for cross-account access or a dedicated key policy). Passing `kmsKeyArn` now encrypts the secret with that customer-managed key: the bulk-init Custom Resource creates the parameter with the CMK, the shared handler is granted `kms:Decrypt`/`Encrypt`/`GenerateDataKey*` scoped to that specific key ARN (instead of the `aws/ssm` `ViaService` wildcard), and the runtime `put()` re-specifies the key on overwrite so it doesn't silently fall back to `aws/ssm`. `kmsKeyArn` is only valid with `secret: true`. The default (no `kmsKeyArn`) is unchanged.
