---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(hosting): drop CloudFront invalidation from BlocksConfigDeployment to avoid CDK #15891 CREATE timeout

The BlocksConfigDeployment BucketDeployment passed a CloudFront distribution/distributionPaths, whose
invalidation-confirmation step times out on fresh stack CREATE (aws-cdk#15891), causing CREATE_FAILED,
a ~30-minute rollback, a retry, and ultimately E2E Hosting job cancellations at the 63-minute CI timeout.
The deployed config.json already sets Cache-Control: public, max-age=60, must-revalidate, so the
invalidation was defense-in-depth only; removing it eliminates the failure with negligible cache impact.
