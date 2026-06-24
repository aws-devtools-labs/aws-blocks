---
"@aws-blocks/bb-knowledge-base": patch
---

fix(bb-knowledge-base): apply the data bucket's removal policy to the S3 Vectors resources on teardown

On a `removalPolicy: 'destroy'` (or sandbox) teardown, the data `s3.Bucket` was force-deleted and auto-emptied, but the S3 Vectors store — the `CfnVectorBucket` + `CfnIndex` L1 resources — relied solely on its default CloudFormation `DeletionPolicy` and leaked. Those resources now mirror the data bucket: `DeletionPolicy: Delete` (via `applyRemovalPolicy(RemovalPolicy.DESTROY)`) when `destroy` is requested, and `RemovalPolicy.RETAIN` otherwise, so the vector bucket and index are dropped alongside the data bucket on a clean teardown.

Purely additive — no exported types, signatures, or error constants changed.
