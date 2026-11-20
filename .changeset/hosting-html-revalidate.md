---
'@aws-cdk-blocks/hosting': patch
---

Prerendered HTML behind the CloudFront door now answers a repeat request's `If-None-Match` with `304 Not Modified`. HTML files are uploaded with `Cache-Control: max-age=0, must-revalidate` instead of `no-cache, no-store, must-revalidate`, so CloudFront keeps a copy and revalidates it on every request. A deploy's new HTML is still served on the first request after it, because every HTML request resolves to the current build's key. Files listed in `staticAssets.noCachePaths` keep `no-cache, no-store, must-revalidate`.
