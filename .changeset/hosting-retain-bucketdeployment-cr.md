---
"@aws-blocks/hosting": patch
---

`HostingConstruct`: retain the CDKBucketDeployment custom resources so they're skipped on stack teardown. A BucketDeployment custom resource runs a delete-time handler (object cleanup / CloudFront invalidation — aws-cdk#15891, aws-cdk#23708); when it fails it wedges the whole stack in `DELETE_FAILED`, orphaning the CloudFront distribution. Retaining the CRs removes them from the teardown path so the stack — and its distribution — delete cleanly (object cleanup is handled by the bucket's `autoDeleteObjects` / sandbox teardown). Observed leaking distributions on the high-volume Amplify SSR-adapter e2e (`deployment-type=standalone`), which consumes this construct.
