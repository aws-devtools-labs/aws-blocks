---
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/blocks": patch
---

fix(bb-knowledge-base): disable `installLatestAwsSdk` on the ingestion custom resource

The `StartIngestion` `AwsCustomResource` left `installLatestAwsSdk` at its default
(`true`), so the provider Lambda ran an `npm install` of the AWS SDK on every
invocation before it could call the API. That costs roughly 15-30s of extra cold
start and forces the provider up to 512MB of memory.

Nothing needed it. The resource calls `BedrockAgent.startIngestionJob`, a stable
API already bundled in the Lambda runtime's AWS SDK v3, so the bundled client is
sufficient and the install is pure overhead. Setting `installLatestAwsSdk: false`
also silences CDK's `installLatestAwsSdkNotSpecified` synth-time warning for this
construct.

Internal construct wiring only — no public API change. The synthesized
`Custom::AWS` resource now renders `InstallLatestAwsSdk: false`.
