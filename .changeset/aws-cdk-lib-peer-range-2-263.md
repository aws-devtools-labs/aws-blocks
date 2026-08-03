---
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/pipeline": patch
"@aws-blocks/blocks": patch
---

Bump `aws-cdk-lib` to `^2.263.0` (+ `aws-cdk` CLI 2.1135, `@aws-sdk/s3-request-presigner` 3.1101).

Each package declares `aws-cdk-lib` as a `peerDependency`, and the range moves to `^2.263.0`. No runtime or API change ships here — only the declared peer range and the resolved lockfile move.

Two follow-on pins keep the tree self-consistent. `aws-cdk-lib` 2.263.0 emits cloud assembly schema 54.0.0, which the `aws-cdk` CLI only reads from 2.1135.0 onward, so the CLI moves with it. Separately, `@aws-sdk/client-s3` floats to 3.1101.0 while `@aws-sdk/s3-request-presigner` had stayed at 3.1046.0; the two ship their own copies of the smithy middleware types, so `getSignedUrl` in `@aws-blocks/bb-file-bucket` stopped accepting an `S3Client` until both matched.

The `@aws-blocks/blocks` umbrella package receives a `patch` because it re-exports these packages. Sibling patch releases stay inside the umbrella's caret ranges, so `changeset version` never bumps it on its own (#212), and it is republished explicitly to stay in step with the packages it hands to consumers.
