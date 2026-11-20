---
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/bb-agent": patch
"@aws-cdk-blocks/bb-app-setting": patch
"@aws-cdk-blocks/bb-async-job": patch
"@aws-cdk-blocks/bb-auth": patch
"@aws-cdk-blocks/bb-cron-job": patch
"@aws-cdk-blocks/bb-dashboard": patch
"@aws-cdk-blocks/bb-email-client": patch
"@aws-cdk-blocks/bb-file-bucket": patch
"@aws-cdk-blocks/bb-knowledge-base": patch
"@aws-cdk-blocks/bb-logger": patch
"@aws-cdk-blocks/bb-metrics": patch
"@aws-cdk-blocks/bb-realtime": patch
"@aws-cdk-blocks/bb-secret": patch
---

docs: the README error examples now import the error constants and `isBlocksError` from `aws-cdk-blocks`, which every scaffolded app depends on. The same import works in backend and client code.
