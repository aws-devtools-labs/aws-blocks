---
"@aws-blocks/core": minor
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/bb-distributed-table": minor
"@aws-blocks/bb-file-bucket": minor
"@aws-blocks/blocks": patch
---

An unrecognized `encryption` value on `KVStore`, `DistributedTable` or `FileBucket` now fails the synth with an error that lists the valid values (`'aws-managed'`, `'customer-managed'`, or the block's `fromKmsKey(arn)`). Previously such a value (for example a typo like `'kms-managed'` in untyped JavaScript, or a value loaded from JSON or the environment) only emitted an `UnknownEncryption` warning and fell back to the AWS-managed key, so a request for a customer-managed key could be silently downgraded. Apps that pass a valid value, or omit `encryption`, are unaffected; an app that hits the new error was never getting the encryption it asked for and should correct the value.
