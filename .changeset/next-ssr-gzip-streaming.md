---
'@aws-cdk-blocks/hosting': patch
---

Next.js on Lambda behind the CloudFront door now gzips its streamed server responses for viewers that accept gzip. Before, the server sent them with `content-encoding: identity` and no `Content-Length`, so CloudFront could not compress them and every page's HTML reached the browser uncompressed. The README now also states that the ALB and API Gateway doors compress static files only, and how an app can compress its own server responses there.
