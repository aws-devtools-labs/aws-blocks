---
"@aws-blocks/admin-ui": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth": patch
"@aws-blocks/bb-compute": patch
"@aws-blocks/bb-container-compute": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-database": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-secret": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/blocks": patch
"@aws-blocks/core": patch
"@aws-blocks/create-block": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/hosting": patch
"@aws-blocks/pipeline": patch
---

chore: point package metadata at the `aws/cdk-blocks` repository

The `repository`, `homepage` and `bugs` fields of every package now name `github.com/aws/cdk-blocks`, where the source lives. npm checks `repository.url` against the provenance of a build, so a package that names another repository cannot be published from this one with provenance.
