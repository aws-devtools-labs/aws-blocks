---
'@aws-cdk-blocks/core': minor
'aws-cdk-blocks': patch
---

**Breaking: `AWS_BLOCKS_DISABLE_TEMPLATE_METADATA` is renamed to `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`.** The old name is no longer read and nothing falls back, so a script or CI job that sets it has to be updated.

`AWS_BLOCKS_FRAMEWORK_SINK` is renamed to `CDK_BLOCKS_FRAMEWORK_SINK` for consistency. It is an internal handshake between the CLI and the `cdk` process it spawns on deploy and sandbox, so it needs no action.
