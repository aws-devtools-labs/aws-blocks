---
"@aws-blocks/bb-logger": minor
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

On the Lambda functions AWS Blocks runs through `createLambdaHandler` (the backend API and its event handlers), every `Logger` line now carries `awsRequestId`, the invocation's request id, so you can correlate everything one request logged (for example `filter awsRequestId = "<id>"` in CloudWatch Logs Insights). Core's `createLambdaHandler` runs each invocation with its `awsRequestId` in scope, and overlapping invocations on one container each see their own id. `awsRequestId` is reserved, so context can't replace it, and your own context fields such as `requestId` are kept as is. Building Block authors can read the same id with `currentRequestId()` from `@aws-blocks/core/bb-utils`. Local dev, SSR hosting web functions and container compute set no request id, so the field is absent there.
