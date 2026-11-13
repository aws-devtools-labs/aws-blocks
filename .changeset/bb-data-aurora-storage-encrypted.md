---
'@aws-blocks/bb-data': minor
'@aws-blocks/blocks': minor
---

**BREAKING: synth now fails for a provisioned `Database` unless the `@aws-blocks/bb-data:encryptStorageByDefault` context flag is set (or `storageEncryptionKeyArn` is passed).** Projects scaffolded by `create-blocks-app` already set the flag to `true` and are unaffected. For other projects, choose in `cdk.json`: `true` for a new database (storage encrypted with the AWS-managed `aws/rds` key), or `false` to keep an existing unencrypted cluster exactly as it is. Setting `true` on an existing unencrypted cluster replaces it with a new, empty one — run `npx cdk diff` first, and follow the bb-data README section "Enabling storage encryption on an existing database" to move the data onto an encrypted cluster.

Storage encryption for `Database` is now an explicit choice, so upgrading bb-data never changes the encryption of an existing cluster:

- `true` emits `StorageEncrypted: true`; a `storageEncryptionKeyArn` also turns it on, regardless of the flag.
- `false` leaves `StorageEncrypted` unset (the existing cluster's template is unchanged) and emits a `@aws-blocks/bb-data:StorageEncryptionDisabled` synth warning. It replaces the previous `@aws-blocks/bb-data:StorageEncryptionOptIn` warning, which fired when the flag was absent.
- The flag accepts booleans, `1`/`0`, and the strings `"true"`/`"false"`/`"1"`/`"0"` (case-insensitive); any other value fails synth with the list of accepted values.
- `fromExisting()` connections are unaffected.

The bb-data README now documents the exact snapshot → encrypted restore → `fromExisting()` cut-over steps, including copying the managed credentials secret before switching.
