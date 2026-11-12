---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/hosting": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-auth": patch
"@aws-blocks/data-common": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-container-compute": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-secret": patch
"@aws-blocks/bb-tracer": patch
---

Remove test assertions that duplicate what each test already checks about the current behavior. Tests only; no behavior change.
