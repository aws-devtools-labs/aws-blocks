---
"@aws-cdk-blocks/hosting": patch
---

The stacked door's edge now uses the CloudFront door's security headers. By default that is AWS's managed `SecurityHeadersPolicy`, so a security header the server sets itself (for example `X-Frame-Options: DENY` from middleware) reaches the browser instead of being replaced at the edge. The edge no longer adds a default `Content-Security-Policy`, and its default `Strict-Transport-Security` is the managed policy's (`max-age=31536000`, and a server-set value wins), as on the CloudFront door. With `features.edge.contentSecurityPolicy` set, the edge gets the same custom policy as the CloudFront door with `contentSecurityPolicy`. The edge also no longer creates its own response headers policy by default, so it uses none of the account's response headers policy quota.
