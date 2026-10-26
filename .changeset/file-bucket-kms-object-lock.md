---
"@aws-blocks/bb-file-bucket": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(bb-file-bucket): customer-managed KMS encryption, Object Lock, and a stack-wide default for S3 access logging

- **`encryption`** on `FileBucket` takes the same values as `KVStore` and `DistributedTable`. `'aws-managed'` (the default) keeps SSE-S3. `'customer-managed'` creates a dedicated KMS key for the bucket, with rotation on, and removes it along with the bucket. `FileBucket.fromKmsKey(arn)` uses a key you already own. Both KMS options use S3 Bucket Keys. The runtime role is granted the key permissions, so `put`/`get` and presigned URLs keep working.
- **`objectLock: { mode: 'governance' | 'compliance', retentionDays }`** turns on S3 Object Lock with a default retention for every new object version. It needs versioning (on by default) and a retained bucket, and both are checked at synth: `versioned: false` and a `'destroy'` removal policy, which is the sandbox default, both fail synth. Pass `removalPolicy: 'retain'` to use Object Lock in a sandbox. Object Lock can only be turned on when the bucket is first created.
- **`BlocksDefaults.storageAccessLogging`** (optional) turns S3 server access logging on or off for every `FileBucket` without changing API Gateway access logging. It is unset in both presets, so `FileBucket` still falls back to `accessLogging` and existing stacks deploy unchanged.

`@aws-blocks/core` now parses the `encryption` option in one place for all three storage blocks. An unrecognized value still warns and falls back to the AWS-managed default.
