---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(hosting): composable CF → ALB front door (`frontDoor: { edge, router }`)

Adds a **composed** front door that stacks a CloudFront edge over a regional
Application Load Balancer, rather than choosing one door instead of the other:

```ts
new Hosting(stack, 'Web', { root, api, frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' } });
```

**Design B — CloudFront's single origin is the ALB, and the ALB routes to
everything.** The L3 builds the *full* ALB router (the same one the standalone
`{ kind: 'alb' }` door builds: an asset-proxy Lambda → private S3, the SSR and
image Lambdas, and an API-forwarder → the backend), and a **thin CloudFront
edge** is stacked in front whose single default behavior forwards *all* traffic
to that ALB. CloudFront is pure edge — TLS, the global cache (a cache policy that
honors the origin's `Cache-Control`, so immutable assets are edge-cached while
HTML/API are not), and a BYO edge WebACL — in front of one regional router.
Routing, atomic-release and skew-protection move *onto* the ALB (listener rules +
a build-id-prefixed asset-proxy), not CloudFront's KVS/Functions. The app is
served same-origin from the CloudFront domain, so cookie auth and CORS are
unaffected. This replaces the earlier design where CloudFront kept its own
static/SSR/image origins and forwarded only the API subtree.

Only meaningful with `api` set (there must be a backend to route to); the ALB
uses a bring-your-own `vpc` or a default 2-AZ VPC, and can be made `internal`.
The internal edge → ALB hop is HTTP; the viewer hop is HTTPS at the edge.

Custom domain / TLS and an auto-built edge WebACL on the composed door are
follow-ons (a BYO `waf.webAclArn` is honored today); an app that needs them can
use the default CloudFront door meanwhile. The default CloudFront path is
unchanged and byte-identical (golden test).

Additive and backward-compatible: omit `frontDoor` (or keep `'cloudfront'` /
`{ kind: … }`) and nothing changes. `@aws-blocks/blocks` gets the same bump
because it re-exports `Hosting` and its widened `frontDoor` prop.
