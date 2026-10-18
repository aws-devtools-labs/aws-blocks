---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth-basic": patch
---

feat(hosting): swappable front doors, and bring-your-own doors written as one function

`Hosting` no longer hard-codes CloudFront. The optional `frontDoor` prop picks
the public entry point. Omit it and nothing changes: you get the same CloudFront
distribution as before.

- `'cloudfront'` (default): the global CloudFront CDN.
- `{ kind: 'alb', vpc?, internal?, certificate? }`: a regional Application Load
  Balancer, with no CDN. Server-rendered responses are buffered.
- `{ kind: 'apiGateway', api?: 'http' | 'rest', certificate? }`: Amazon API
  Gateway, with no CDN, no VPC, and scale-to-zero. `'http'` (the default)
  buffers server-rendered responses; `'rest'` streams them. `'rest'` needs a
  custom `domain`: its own URL carries the `/prod` stage, which the app's
  root-relative links miss, so synth fails without one
  (`RestFrontDoorNeedsDomainError`).
- `{ kind: 'stacked', edge: 'cloudfront', router: 'alb', vpc?, internal? }`: a
  thin CloudFront edge in front of a full ALB router.
- `'none'`: no front door. A static site or SPA is served straight from an S3
  website bucket over HTTP. An app with a server fails synth.
- `{ kind: 'custom', door, wiringCheck? }`: your own door.

Every door serves the API on the app's own origin (except `'none'`, where the
browser calls the API cross-origin): `/aws-blocks/*` (RPC and sign-in) and each
of the backend's raw routes. It also claims the backend's API front-door role,
so `apiFrontDoor: 'cloudfront'` does not build a second distribution.

Each door kind takes the settings the app asks it for as `features`, typed for
that kind: a setting the chosen door doesn't implement does not compile.
`{ features }` with no `kind` is the CloudFront default with settings.

- CloudFront: `domain`, `waf`, `logging`, `monitoring`, `skewProtection`,
  `geoRestriction`, `priceClass`, `contentSecurityPolicy`, `ssrDefaultTtl`,
  `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas`.
- ALB: `waf` (a REGIONAL web ACL), `logging`, `monitoring` (`enabled` only).
  Logging and alarms apply only when `enabled` is not `false`. For HTTPS, give
  the door a regional `certificate`; the ALB door creates no DNS records.
- API Gateway (HTTP and REST): `domain` (without `wwwRedirect`).
- Stacked: per layer, `edge: { waf: { webAclArn }, contentSecurityPolicy }` (a
  CLOUDFRONT-scoped web ACL) and `router: { waf, logging, monitoring }` (a
  REGIONAL one).
- Custom: `domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
  `skewProtection`, handed to the door as `input.features`.
- `'none'`: no settings.

**Deprecated (still supported):** the top-level settings props. On `Hosting`
(`@aws-blocks/core`): `domain`, `waf`, `logging`, `monitoring`,
`skewProtection`, `contentSecurityPolicy`, `priceClass`, `geoRestriction`,
`quotas`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`. On
`HostingConstruct` (`@aws-blocks/hosting`): `domain`, `waf`, `logging`,
`monitoring`, `skewProtection` and `cdn` (each `cdn.<x>` is
`frontDoor.features.<x>`; `cdn.webAclArn` is `frontDoor.features.waf.webAclArn`).
Use `frontDoor.features.<x>` instead: the names are the same, so migrating is a
straight move. The aliases are merged into `frontDoor.features` at
construction, and an app that sets them with no `frontDoor` (or `'cloudfront'`)
synthesizes the same template. Setting a setting both ways fails synth with
`FrontDoorSettingConflictError`, naming both; a top-level prop the chosen kind
doesn't implement fails synth with `UnsupportedFrontDoorSettingError`, naming
the kind and the prop.

The ALB and API Gateway doors serve static files through an asset-proxy Lambda
that answers like the CloudFront door: a missing file returns 404 (the SPA
fallback applies only to paths without an extension), and each file is served
with the `Cache-Control` it was uploaded with.

The server is built for the door in front of it. Behind a door that invokes it
without streaming (the ALB, the stacked door's ALB router, the API Gateway HTTP
API), a Lambda Web Adapter server (Astro, Nuxt, SvelteKit) answers buffered.
Next.js builds target a streaming API Gateway REST integration, so serve
Next.js through CloudFront, the `'rest'` door, or a door that streams.

A bring-your-own door is one function:
`defineFrontDoor({ service, serverResponse?, build(scope, input) })` from
`@aws-blocks/hosting/constructs`. `Hosting` calls `build` once at synth, after it
has created the bucket, compute and API and before it declares the asset
uploads. A door that invokes the server without streaming sets
`serverResponse: 'buffered'` (the default is `'streaming'`). The door receives
a `DoorInput`:

- `app`: the build id, base path, Next.js asset prefix, SPA fallback, routes
  already joined to their origins, redirects, headers and error pages.
- `origins`: the assets bucket and build prefix, the server and image Lambdas
  with their Function URLs (the server's `streaming` says whether it streams,
  and its Function URL uses the matching invoke mode), and the API with every
  path that must reach it.
  The API paths are `/aws-blocks/*` (RPC and sign-in) plus the backend's raw
  routes.
- `features`: the door's `frontDoor.features`, under the same names and shapes
  (`domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
  `skewProtection`). A field is present only when the app asked for that
  feature; skew protection is on by default.

The door returns `{ url, originHandle?, publicBucket?, onUpload? }`.

- `url` is required. It becomes `HostingUrl`, `Hosting.url`,
  `BLOCKS_PUBLIC_ORIGIN` and an allowed CORS origin. A missing `url` fails synth
  with `MissingFrontDoorUrlError`.
- `originHandle` is derived from `url` when the door doesn't return one.
- `onUpload` runs after the asset uploads are declared, so the door can add
  something that runs after them, such as a cache invalidation.

The `cf.*` helpers (`cf.origin`, `cf.behaviors`, `cf.apiBehaviors`,
`cf.redirects`, `cf.headers`, `cf.errorPages`, `cf.invalidate`) build
CloudFront origins, behaviors, functions and error responses from the input
and record what they wired. `cf.redirects` and `cf.headers` run the same
matcher as the built-in CloudFront door; `cf.errorPages` returns the same error
responses. From that record, synth fails if nothing reaches the
static assets (`ServeStaticAsset`). It also fails if the app has an API and
none of its paths were wired (`ProxySameOriginApi`). Unwired API paths, and
app redirects, headers or error pages the door didn't wire, are synth warnings.
A door that wires with raw
CDK declares it with `cf.recordWired(...)`, or turns the check off with
`wiringCheck: false`. `assertDoorConformance(door)` runs the same checks in a
door's own tests.

The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
`s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way. The pieces they
share are exported for your own doors: `generateAlbAssetProxyCode`,
`generateApiGwAssetProxyCode`, `backendBaseUrl`, `coalesceRoutes`,
`routeSpecificity` and `createSecurityHeadersPolicy`.

Auth works behind every door. CORS origin matching is case-insensitive, and the
session cookie drops `Secure` when the deployed front door serves over plain
HTTP (`isInsecurePublicOrigin()` in `@aws-blocks/auth-common`), so sign-in works
behind an S3 website or an ALB without TLS.
