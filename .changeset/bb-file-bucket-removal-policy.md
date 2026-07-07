---
"@aws-blocks/bb-file-bucket": patch
---

Fix `FileBucket` silently dropping bucket contents in non-sandbox stacks. Previously an explicit `removalPolicy: 'destroy'` enabled `autoDeleteObjects` in any stack, which provisions a hidden `Custom::S3AutoDeleteObjects` Lambda whose delete behavior cannot be overridden by stack-level retention Aspects (`RemovalPolicies.of(stack).retain()`). `autoDeleteObjects` is now enabled only in sandbox mode, so prod buckets honor retention.
