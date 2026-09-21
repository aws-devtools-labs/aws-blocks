---
"@aws-blocks/core": minor
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-realtime": patch
---

feat(core): forward the native client user-agent into the AWS SDK user agent

Native runtimes send `x-blocks-user-agent: aws-blocks-<lang>/<version>` on the RPC
request. `@aws-blocks/core` validates it against a strict grammar (length-capped,
dropped silently when malformed), carries it per request in an `AsyncLocalStorage`,
and exports `installClientUserAgent`, an SDK middleware that appends the validated
token to the outgoing user agent. Every Building Block that configures an SDK client
installs it, so native attribution rides the SDK user-agent chain AWS service
telemetry already counts. Inert until a client sends the header.
