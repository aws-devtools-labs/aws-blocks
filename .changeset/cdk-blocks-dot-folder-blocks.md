---
'@aws-cdk-blocks/bb-app-setting': patch
'@aws-cdk-blocks/bb-async-job': patch
'@aws-cdk-blocks/bb-auth': patch
'@aws-cdk-blocks/bb-dashboard': patch
'@aws-cdk-blocks/bb-email-client': patch
'@aws-cdk-blocks/bb-file-bucket': patch
'@aws-cdk-blocks/bb-knowledge-base': patch
'@aws-cdk-blocks/bb-kv-store': patch
'@aws-cdk-blocks/bb-logger': patch
'@aws-cdk-blocks/bb-metrics': patch
'@aws-cdk-blocks/bb-realtime': patch
'@aws-cdk-blocks/bb-secret': patch
'@aws-cdk-blocks/bb-tracer': patch
'@aws-cdk-blocks/create-block': patch
---

Local Building Block data now lives under `.cdk-blocks/local/data/{fullId}/`. It was `.bb-data/{fullId}/`. Data already on disk is copied across the first time a block opens its store, and nothing in the new location is overwritten. This is part of the hidden folder rename in this release. The `@aws-cdk-blocks/core` changelog has the full migration steps.
