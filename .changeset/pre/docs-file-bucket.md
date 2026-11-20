---
"@aws-cdk-blocks/bb-file-bucket": patch
---

docs: no method throws `FileBucketErrors.FileNotFound` or `FileTooLarge`. `get()` returns `null` for a missing file, and an upload over `maxUploadBytes` throws `ValidationFailed`, matched with `isBlocksError(e, 'ValidationFailed')`.
