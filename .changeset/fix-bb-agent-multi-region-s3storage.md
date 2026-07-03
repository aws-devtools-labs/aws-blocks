---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): use the Lambda execution region for S3Storage (#120)

The deployed Agent constructed Strands' `S3Storage` without a `region`, so it defaulted to `us-east-1` and hard-pinned the snapshot S3 client there. Because the session bucket is created in the deploy region, any deployment outside `us-east-1` failed snapshot reads/writes with a cross-region 301 `PermanentRedirect`. `S3Storage` is now constructed with `region: process.env.AWS_REGION` — which the Lambda runtime always sets to the function's region — so snapshots resolve against the correct regional endpoint. `region` and `s3Client` are mutually exclusive in `S3StorageConfig`, so only `region` is passed.
