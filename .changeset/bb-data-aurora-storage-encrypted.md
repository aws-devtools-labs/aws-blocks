---
'@aws-blocks/bb-data': minor
'@aws-blocks/blocks': minor
---

**BREAKING:** Aurora storage encryption is now on by default for a provisioned `Database` (`StorageEncrypted: true`, with the account's AWS-managed `aws/rds` key). An existing cluster that was created without encryption is detected before deploy and the deploy stops — it is not replaced. To keep such a cluster as it is, set `"@aws-blocks/bb-data:encryptStorageByDefault": false` in the `context` section of `cdk.json`; to move it to an encrypted cluster, follow the bb-data README section "Enabling storage encryption on an existing database".

- The `@aws-blocks/bb-data:encryptStorageByDefault` context flag is optional: absent or `true` encrypts storage, and `false` is an explicit opt-out that leaves `StorageEncrypted` unset (the existing cluster's template is unchanged) and emits a `@aws-blocks/bb-data:StorageEncryptionDisabled` synth warning. It replaces the previous `@aws-blocks/bb-data:StorageEncryptionOptIn` warning, which fired when the flag was absent.
- A `storageEncryptionKeyArn` encrypts storage with that customer-managed key, regardless of the flag.
- The flag accepts booleans, `1`/`0`, and the strings `"true"`/`"false"`/`"1"`/`"0"` (case-insensitive); any other value fails synth with the list of accepted values.
- bb-data declares a pre-deploy check (`aws-blocks.predeploy`, production and sandbox stages) that `npm run deploy` / `npm run sandbox` run before `cdk deploy`. For each managed cluster the synthesized template encrypts, it reads the deployed stack from CloudFormation and stops the deploy when the deployed cluster is unencrypted. It only reads (`DescribeStacks`, `DescribeStackResource`, `GetTemplate`) and fails closed when it cannot verify; `BLOCKS_SKIP_STORAGE_ENCRYPTION_CHECK=1` skips it for one deploy. `npx cdk deploy` run directly and `cdk watch` iterations do not run it.
- `fromExisting()` connections are unaffected.

The bb-data README documents the exact snapshot → encrypted restore → `fromExisting()` cut-over steps, including copying the managed credentials secret before switching.
