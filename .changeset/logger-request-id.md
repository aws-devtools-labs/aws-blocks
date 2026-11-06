---
"@aws-blocks/bb-logger": minor
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

On the Lambda functions AWS Blocks runs through `createLambdaHandler` (the backend API and its event handlers), every `Logger` line now carries `requestId`, the invocation's request id, so you can correlate everything one request logged (for example `filter requestId = "<id>"` in CloudWatch Logs Insights). Core's `createLambdaHandler` runs each invocation with its `awsRequestId` in scope, and overlapping invocations on one container each see their own id. A `requestId` you pass in context still takes precedence. Building Block authors can read the same id with `currentRequestId()` from `@aws-blocks/core/bb-utils`. Local dev, SSR hosting web functions and container compute set no request id, so the field is absent there.
