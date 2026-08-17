---
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/blocks": patch
---

fix(bb-knowledge-base): disable `installLatestAwsSdk` on the ingestion custom resource

The `StartIngestion` `AwsCustomResource` left `installLatestAwsSdk` at its default
(`true`), so the provider Lambda ran an `npm install` of the AWS SDK on every
invocation before it could call the API. That costs roughly 15-30s of extra cold
start and raises the shared provider Lambda to 512MB of memory, though that
reduction is only realized once every `AwsCustomResource` in the stack opts out —
the provider is a stack-level singleton and its `memorySize` is resolved once at
synth. The per-resource cold-start saving applies regardless.

Nothing needed it. The resource calls `BedrockAgent.startIngestionJob`, a stable
API already bundled in the Lambda runtime's AWS SDK v3, so the bundled client is
sufficient and the install is pure overhead. Setting `installLatestAwsSdk: false`
also silences CDK's `installLatestAwsSdkNotSpecified` synth-time warning for this
construct.

The tradeoff being accepted: the provider now uses whichever SDK v3 the Lambda
runtime bundles at deploy time rather than installing the newest one. That is safe
here because `startIngestionJob` is a foundational Bedrock Agent operation present
since the client's initial release, not a recent addition.

Internal construct wiring only — no public API change. The synthesized
`Custom::AWS` resource now renders `InstallLatestAwsSdk: false`.

Upgrade note: because `InstallLatestAwsSdk` renders as a property on the
`Custom::AWS` resource while the `physicalResourceId` stays stable, the first
deploy after upgrading is a CloudFormation *Update* and fires `onUpdate` — so one
`startIngestionJob` kicks off. This is harmless (ingestion is idempotent and
fire-and-forget), but expect to see an ingestion start right after upgrading.
