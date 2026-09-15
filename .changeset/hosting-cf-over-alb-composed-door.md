---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(hosting): composable CF → ALB front door (`frontDoor: { edge, router }`)

Adds a **composed** front door that stacks a CloudFront edge over a regional
Application Load Balancer, rather than choosing one door instead of the other:

```ts
new Hosting(stack, 'Web', { root, api, frontDoor: { edge: 'cloudfront', router: 'alb' } });
```

The edge serves static / SSR / image origins exactly as the default CloudFront
door does (byte-identical — the default path is unchanged and guarded by the
golden test). What changes is the same-origin API subtree: `/aws-blocks/*` and
`/aws-blocks-auth/*` now flow **CloudFront → ALB → backend** (a forwarder Lambda
target on the ALB) instead of CloudFront → API Gateway directly. This makes the
ALB the API router while the edge keeps every CloudFront capability, and lets the
ALB carry its own native cross-cutting features (WAFv2 REGIONAL, access logs,
CloudWatch alarms) on the router layer.

Only meaningful with `api` set (there must be a backend to route to); the ALB
uses a bring-your-own `vpc` or a default 2-AZ VPC, and can be made `internal`.

Also exposes `HostingConstruct.buildId` (the immutable per-deploy Build ID) so a
composed router layer can prefix the same `builds/<buildId>/` asset keys.

Additive and backward-compatible: omit `frontDoor` (or keep `'cloudfront'` /
`{ kind: … }`) and nothing changes. `@aws-blocks/blocks` gets the same bump
because it re-exports `Hosting` and its widened `frontDoor` prop.
