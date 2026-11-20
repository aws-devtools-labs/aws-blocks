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

docs: import error constants from `aws-cdk-blocks` in the README examples

The error examples in the READMEs of `Agent`, `AppSetting`, `AsyncJob`, `Auth`, `CronJob`, `Dashboard`, `EmailClient`, `FileBucket`, `KnowledgeBase`, `Logger`, `Metrics`, `Realtime` and `Secret`, and the `hasAuthError` example in the core README, imported the error constants and `isBlocksError` from the block's own package and `@aws-cdk-blocks/core`. An app made with `npm create @aws-cdk-blocks/blocks-app` does not declare those packages. The examples now import from `aws-cdk-blocks`, and the same line works in backend and client code.
