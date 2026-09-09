---
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/blocks": patch
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/data-common": patch
"@aws-blocks/hosting": patch
"@aws-blocks/pipeline": patch
---

Add npm keywords for discoverability via `npm search keywords:aws-blocks`

Every published package now carries an npm `keywords` array: the shared `aws-blocks`
discovery tag plus 2–5 functional keywords describing the package's domain and the
AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
`ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
API, or behavior change.
