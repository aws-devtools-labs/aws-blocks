---
"@aws-blocks/hosting": patch
---

fix(hosting): disable installLatestAwsSdk on the CDN invalidation custom resource

The `DeployInvalidation` `AwsCustomResource` in `CdnConstruct` left
`installLatestAwsSdk` at its CDK default of `true`. That default makes the
custom-resource provider Lambda `npm install` the AWS SDK at invoke time,
adding roughly 15-30s of cold start and forcing a 512MB memory floor on the
provider function.

Nothing here needs a newer SDK than the runtime ships. The resource makes a
single `CloudFront.createInvalidation` call — a long-stable API already bundled
in the Lambda runtime's AWS SDK v3. And unlike a one-off resource, this one
fires on *every* hosting deploy (its `CallerReference`/`physicalResourceId` are
keyed on `buildId`), so the install cost was paid on every deploy rather than
once.

Setting `installLatestAwsSdk: false` removes that per-deploy penalty and also
silences CDK's `installLatestAwsSdkNotSpecified` warning for this construct.
No public API or template change beyond the `InstallLatestAwsSdk: false`
property on the synthesized `Custom::AWS` resource; invalidation behavior,
IAM policy, and deploy ordering are unchanged.
