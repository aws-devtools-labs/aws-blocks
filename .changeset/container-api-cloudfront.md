---
'@aws-blocks/core': minor
'@aws-blocks/blocks': patch
'@aws-blocks/bb-compute': patch
'@aws-blocks/bb-container-compute': patch
---

On the `apiFrontDoor: 'cloudfront'` tier, CloudFront now routes an API namespace on a `container` compute straight to the container's load balancer, instead of through the shared API gateway — from the backend's managed distribution, or from `Hosting`'s default CloudFront door when it fronts the API. A call can run up to 60 seconds (CloudFront's origin read timeout) instead of the gateway's ~29, and skips a hop.

- Each container namespace path (`/aws-blocks/api/<export name>`) gets its own CloudFront behavior, ahead of the `/aws-blocks/api/*` gateway behavior, all on one VPC origin per distribution for the backend's load balancer listener (whose path rules pick the compute) — so a distribution uses one of the account's VPC origins (25 by default) however many containers serve API traffic. Namespaces on Lambda computes, auth routes and `RawRoute`s still go through the gateway.
- A viewer-request CloudFront Function stamps the viewer's host on those requests, so `ctx.request.url` in the container is the public URL, including a custom domain.
- The load balancer admits CloudFront's origin-facing prefix list on its listener ports; the prefix list is looked up at deploy time, so stacks stay environment-agnostic.
- A direct call skips the gateway's throttling and access logs; the distribution's web ACL (`apiWaf`, or Hosting's WAF) covers it, and synth warns when there is none.
- On the `apigateway` tier nothing changes: container namespaces go through the gateway, behind `Hosting` too.
