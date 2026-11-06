---
'@aws-blocks/core': minor
'@aws-blocks/blocks': patch
'@aws-blocks/bb-compute': patch
'@aws-blocks/bb-container-compute': patch
'@aws-blocks/bb-auth-oidc': patch
---

Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is now the URL the client called: the distribution's domain, or the custom domain it was called at, with no API Gateway stage (`https://d111.cloudfront.net/aws-blocks/api/orders`, not `https://<id>.execute-api.<region>.amazonaws.com/prod/aws-blocks/api/orders`). Links and redirects a handler builds from it stay on the public domain, where the app's cookies are scoped. A container namespace behind the same door already reported that URL; the two compute types now agree.

- Applies to the `apiFrontDoor: 'cloudfront'` distribution and to `Hosting`'s CloudFront door (on either tier). A viewer-request CloudFront Function on their API behaviors to the gateway stamps the viewer's host as `x-blocks-public-host`; each door registers its hosts under the backend's `BLOCKS_PUBLIC_HOSTS` config.
- A handler takes the stamped host only when it is one of those hosts — a subdomain at any depth for a wildcard alias (`*.example.com`), as CloudFront serves it, but not its apex. The gateway is reachable directly, so a caller can send the header; a forged value can at most name another of the app's own domains.
- Requests sent to the `execute-api` URL directly, and requests through `Hosting`'s other doors (ALB, API Gateway, stacked, bring-your-own), keep reporting the gateway URL, stage included.
- The sandbox dev server's loopback `X-Forwarded-Host` still takes precedence, so redirect-based sign-in in a sandbox keeps working through the CloudFront URL. In both the Lambda handler and the container, it now contributes only its host: a query, fragment or userinfo in it no longer reaches `ctx.request.url`, and a request path starting `//` or `/\` can't change the URL's host.
- A container namespace the gateway proxies to behind a Blocks CloudFront door (on the `apigateway` tier, or when CloudFront can't reach its VPC) also reports the public URL now, instead of the gateway's.
- Each CloudFront door adds one CloudFront Function to the account.
