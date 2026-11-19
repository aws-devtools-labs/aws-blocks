---
"@aws-cdk-blocks/hosting": patch
"@aws-cdk-blocks/pipeline": patch
"aws-cdk-blocks": patch
---

Document hosting front-door compatibility, including how to build a buffered Next.js server for an API Gateway HTTP API. Add hosting options and synth-error references, and ship the custom front-door guide with the package.

Update the pipeline quick start to use `Pipeline.create()` with the AWS CDK Blocks store prefixes and a separate pipeline entry point. Document the pipeline options and their defaults.
