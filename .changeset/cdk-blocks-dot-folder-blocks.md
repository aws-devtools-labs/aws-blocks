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

Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`. Existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
