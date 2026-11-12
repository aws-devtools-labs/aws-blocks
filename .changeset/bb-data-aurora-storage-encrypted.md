---
'@aws-blocks/bb-data': minor
'@aws-blocks/blocks': minor
---

Aurora storage encryption is now always enabled for `Database`. The cluster is synthesized with `StorageEncrypted: true` whether or not the `@aws-blocks/bb-data:encryptStorageByDefault` context flag is set, using the account's AWS-managed `aws/rds` key by default or the key named by `storageEncryptionKeyArn`. The `@aws-blocks/bb-data:StorageEncryptionOptIn` synth warning is removed, and setting the context flag to `false` now fails synth with an error, since storage encryption can no longer be turned off.

**Migration:** storage encryption cannot be enabled on an existing Aurora cluster in place. A stack whose cluster was created unencrypted (deployed without the context flag and without `storageEncryptionKeyArn`) will have that cluster **replaced** on its next deploy — the new cluster starts empty and without schema. Before upgrading, snapshot the existing cluster and migrate its data (snapshot → restore with encryption enabled → cut over); see the `bb-data` README note "Enabling encryption on an existing unencrypted cluster". Projects that already set the context flag to `true` or pass `storageEncryptionKeyArn` are unaffected.
