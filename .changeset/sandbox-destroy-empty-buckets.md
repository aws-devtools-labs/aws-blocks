---
"@aws-blocks/core": patch
---

`destroySandbox` (used by `npm run destroy` and per-job E2E teardown): empty versioned S3 buckets before retrying `cdk destroy`. Teardown relies on each bucket's `autoDeleteObjects` Lambda, which never provisions if the CREATE failed, so a versioned bucket blocked the delete and the stack (and its IAM roles) leaked. On a destroy failure the buckets owned by the app's stacks are now emptied (all object versions + delete markers, paginated) before the retry, alongside the existing VPC-ENI backoff.
