---
'@aws-blocks/hosting': patch
---

The CloudFront door now serves a server built as a buffered Lambda handler. Its server origin (the SSR REST API) integrated every server Lambda with `ResponseTransferMode: STREAM`, which cannot read the `{ statusCode, headers, body }` object a buffered handler returns. A Nuxt (Nitro) app built with the `aws-lambda` preset and `nitro.awsLambda.streaming` left off, which is Nitro's default, deployed without an error and answered 502 on every path. The integration now follows the server as built, as the API Gateway REST door already does: a streaming server (Next.js through OpenNext, Nitro with `awsLambda.streaming: true`, a Lambda Web Adapter server) keeps the STREAM integration, and a buffered handler gets a plain Lambda proxy integration. A buffered response is sent whole once the handler returns, and Lambda limits it to 6 MB.

A Nuxt app that leaves `awsLambda.streaming` off now works behind both the CloudFront door and the API Gateway HTTP API door. Turning streaming off is what `StreamingServerNeedsStreamingDoorError` suggests for a door that cannot stream, and that build no longer breaks the CloudFront deploy.
