---
"@aws-blocks/bb-file-bucket": patch
---

Fix `FileBucket` silently dropping bucket contents in non-sandbox stacks. Previously an explicit `removalPolicy: 'destroy'` enabled `autoDeleteObjects` in any stack, which provisions a hidden `Custom::S3AutoDeleteObjects` Lambda whose delete behavior cannot be overridden by stack-level retention Aspects (`RemovalPolicies.of(stack).retain()`). `autoDeleteObjects` now defaults to sandbox-only, so prod buckets honor retention.

Behavior change: in a non-sandbox stack, `removalPolicy: 'destroy'` now sets `RemovalPolicy.DESTROY` without auto-empty. `cdk destroy` on a non-empty prod bucket will fail with `DELETE_FAILED` (S3 rejects deleting a non-empty bucket) instead of silently wiping it. Callers relying on `'destroy'` for full teardown of a populated prod bucket should either empty it first or opt in explicitly (below).

New `FileBucketOptions.autoDeleteObjects?: boolean` escape hatch: defaults to sandbox-only behavior, but can be set `true` to force auto-empty for a genuinely-ephemeral prod bucket, or `false` to disable it even in sandbox. Only takes effect when the bucket is being destroyed.
